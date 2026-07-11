import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createCardActionHandler, createManagerApp, createMessageHandler, renderCardActionResponse, seedFixedReminders } from "../src/manager-app.mjs";
import { openDatabase } from "../src/db/database.mjs";
import { createOperationsRepository } from "../src/db/operations-repository.mjs";

test("seeds four idempotent Sunday weekly-plan reminders in the configured timezone", () => {
  const db = openDatabase(":memory:");
  const ops = createOperationsRepository(db);
  const input = {
    now: new Date("2026-07-12T00:00:00.000Z"),
    config: { schedule: { weeklyPlan: "22:00", plan: "08:00", midday: "12:00", afternoon: "14:00", dayClose: "18:00", eveningStart: "20:00", eveningEnd: "24:00" } },
    settings: { timezone: "Asia/Shanghai" }, ops,
  };

  seedFixedReminders(input);
  seedFixedReminders(input);

  const weekly = ops.listReminders({ status: "pending" }).filter((item) => item.kind === "weekly_plan");
  assert.equal(weekly.length, 4);
  assert.equal(weekly[0].dueAt, "2026-07-12T14:00:00.000Z");
  assert.equal(weekly[0].idempotencyKey, "fixed:weekly-plan:2026-W28");
  db.close();
});

test("weekly-plan reminder follows local Sunday time across daylight-saving changes", () => {
  const db = openDatabase(":memory:");
  const ops = createOperationsRepository(db);
  seedFixedReminders({
    now: new Date("2026-10-25T12:00:00.000Z"),
    config: { schedule: { weeklyPlan: "22:00", plan: "08:00", midday: "12:00", afternoon: "14:00", dayClose: "18:00", eveningStart: "20:00", eveningEnd: "24:00" } },
    settings: { timezone: "America/New_York" }, ops,
  });
  const weekly = ops.listReminders({ status: "pending" }).filter((item) => item.kind === "weekly_plan");
  assert.equal(weekly[0].dueAt, "2026-10-26T02:00:00.000Z");
  assert.equal(weekly[1].dueAt, "2026-11-02T03:00:00.000Z");
  db.close();
});

test("start callback replaces the source card with a doing-state card", () => {
  const response = renderCardActionResponse(
    { action: "start" },
    {
      action: "start",
      task: {
        id: "task-1",
        title: "拍视频",
        status: "doing",
        nextAction: "打开提纲",
        doneDefinition: "交付可剪辑素材",
      },
    },
  );
  const row = response.card.body.elements.find((element) => element.tag === "column_set");
  const actions = row.columns.flatMap((column) => column.elements)
    .map((button) => button.behaviors[0].value.action);

  assert.match(response.toast.content, /已开始/);
  assert.deepEqual(actions, ["complete", "block", "defer_30"]);
});

test("starts locally, seeds seven days of fixed reminders, recovers, and stops cleanly", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "time-manager-app-"));
  const intervals = [];
  const app = createManagerApp(
    {
      dbPath: path.join(dir, "manager.sqlite"),
      dataDir: dir,
      backupDir: path.join(dir, "backups"),
      markdownExportDir: path.join(dir, "exports"),
      kbDir: path.join(dir, "missing-kb"),
      codexBin: "/missing/codex",
      timezone: "Asia/Shanghai",
      managerUserId: "user-1",
      feishuReceiveId: "user-1",
      feishuReceiveIdType: "open_id",
      schedule: {
        plan: "08:30", firstTask: "10:00", midday: "12:00", afternoon: "14:00",
        dayClose: "18:00", eveningStart: "20:00", eveningEnd: "22:00", noResponseMinutes: 15,
      },
    },
    {
      clock: { now: () => new Date("2026-07-11T00:00:00.000Z") },
      connectFeishu: async () => ({ stop: async () => {} }),
      setInterval: (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; },
      clearInterval: () => {},
    },
  );

  await app.start();
  const pending = app.state.ops.listReminders({ status: "pending" });
  assert.equal(pending.filter((row) => row.kind === "daily_plan").length, 7);
  assert.equal(pending.filter((row) => row.kind === "daily_review").length, 7);
  assert.equal(intervals.length, 2);
  assert.equal(app.state.ops.listOutbox().some((row) => row.kind === "recovery_plan_card"), true);
  assert.equal(app.state.settings.maxCriticalTasks, 5);
  assert.deepEqual(app.state.settings.projectMinimums, { "个人IP": 2, "极享OS": 2 });
  assert.deepEqual(app.state.settings.projectWindows["个人IP"], [["10:00", "12:00"], ["14:00", "16:00"]]);
  await app.stop();
});

test("weekly confirmation awaits persistence and replaces the source card", async () => {
  let confirmed = false;
  const callback = createCardActionHandler({
    manager: { handleAction: async () => ({}) },
    projectRepo: {},
    weeklyPlanning: {
      confirm: async ({ weekId, version, eventId }) => {
        await Promise.resolve();
        confirmed = true;
        assert.deepEqual({ weekId, version, eventId }, { weekId: "2026-W29", version: 2, eventId: "card:evt-confirm" });
        return { weekId, version, status: "confirmed" };
      },
    },
  });

  const response = await callback({ action: "confirm_weekly_plan", weekId: "2026-W29", version: 2, idempotencyKey: "card:evt-confirm" });
  assert.equal(confirmed, true);
  assert.match(JSON.stringify(response.card), /周计划已确认/);
});

test("project setup confirmation activates every source draft and replaces the source card", async () => {
  const calls = [];
  const callback = createCardActionHandler({
    manager: { handleAction: async () => ({}) },
    weeklyPlanning: {},
    projectRepo: {
      confirmDraft: async (projectId, contentHash) => {
        calls.push([projectId, contentHash]);
        return { id: projectId, name: projectId === "personal-ip" ? "个人IP" : "极享OS", status: "active" };
      },
    },
  });
  const projects = [{ projectId: "personal-ip", contentHash: "hash-1" }, { projectId: "jixiang-os", contentHash: "hash-2" }];

  const response = await callback({ action: "confirm_project_setup", projects, idempotencyKey: "card:evt-projects" });

  assert.deepEqual(calls, [["personal-ip", "hash-1"], ["jixiang-os", "hash-2"]]);
  assert.match(JSON.stringify(response.card), /项目初始设置已确认/);
});

test("weekly adjustment prompts for a concrete reason without confirming", async () => {
  let confirmations = 0;
  const callback = createCardActionHandler({
    manager: { handleAction: async () => ({}) }, projectRepo: {},
    weeklyPlanning: { confirm: async () => { confirmations += 1; } },
  });
  const response = await callback({ action: "adjust_weekly_plan", weekId: "2026-W29", version: 1 });
  assert.match(response.toast.content, /调整周计划｜具体原因/);
  assert.equal(confirmations, 0);
});

test("routes a weekly adjustment reply to weekly planning with the pending plan identity", async () => {
  const settings = new Map([["pending_weekly_adjustment", { weekId: "2026-W29", version: 1 }]]);
  const ops = {
    getSetting: (key) => settings.get(key),
    setSetting: (key, value) => settings.set(key, value),
  };
  let input;
  const handler = createMessageHandler({
    config: { feishuReceiveId: "owner", feishuReceiveIdType: "open_id" }, ops,
    manager: { handleAction: async () => assert.fail("manager action must not handle weekly adjustment") },
    weeklyPlanning: { requestAdjustment: async (value) => { input = value; } },
  });

  await handler({ kind: "message", text: "调整周计划｜任务太多", messageId: "msg-adjust" });

  assert.deepEqual(input, { weekId: "2026-W29", version: 1, reason: "任务太多", eventId: "message:msg-adjust" });
  assert.equal(settings.get("pending_weekly_adjustment"), null);
});

test("app exposes a callable weekly generation path after setup", async () => {
  const generated = [];
  const projectRepo = { ensureDraftTemplates: async () => ({ projects: [] }) };
  const app = createManagerApp({
    dbPath: ":memory:", kbDir: "/unused", backupDir: "/unused", markdownExportDir: "/unused",
    timezone: "Asia/Shanghai", feishuReceiveId: "owner",
    schedule: { plan: "08:30", firstTask: "10:00", midday: "12:00", afternoon: "14:00", dayClose: "18:00", eveningStart: "20:00", eveningEnd: "22:00", noResponseMinutes: 15 },
  }, {
    projectRepo, weeklyPlanRepo: {}, weeklyPlanning: { generateDraft: async (input) => { generated.push(input); return { status: "draft" }; } },
    connectFeishu: async () => ({ stop: async () => {} }), setInterval: () => 1, clearInterval: () => {},
  });

  await app.generateWeeklyPlan({ weekId: "2026-W29" });
  assert.deepEqual(generated, [{ weekId: "2026-W29" }]);
  await app.stop();
});

test("Sunday reminder generates the matching ISO-week draft through the composed service", async () => {
  let now = new Date("2026-07-12T13:59:00.000Z");
  const generated = [];
  const app = createManagerApp({
    dbPath: ":memory:", kbDir: "/unused", backupDir: "/unused", markdownExportDir: "/unused",
    timezone: "Asia/Shanghai", feishuReceiveId: "owner",
    schedule: { weeklyPlan: "22:00", plan: "08:00", firstTask: "10:00", midday: "12:00", afternoon: "14:00", dayClose: "18:00", eveningStart: "20:00", eveningEnd: "24:00", noResponseMinutes: 10 },
  }, {
    clock: { now: () => now },
    projectRepo: { ensureDraftTemplates: async () => ({ projects: [] }) }, weeklyPlanRepo: {},
    weeklyPlanning: { generateDraft: async (input) => { generated.push(input); } },
    connectFeishu: async () => ({ stop: async () => {} }), setInterval: () => 1, clearInterval: () => {},
  });
  await app.start();
  now = new Date("2026-07-12T14:01:00.000Z");
  await app.state.reminderEngine.processDue();
  assert.deepEqual(generated, [{ weekId: "2026-W28" }]);
  await app.stop();
});

test("routes text-only evidence without ingesting it as a task", async () => {
  let submitted;
  const handler = createMessageHandler({
    config: { managerUserId: "owner", feishuReceiveId: "owner" },
    ops: { setSetting() {} }, weeklyPlanning: {},
    manager: {
      listPendingAcceptance: () => [{ id: "task-1" }],
      submitEvidence: async (input) => { submitted = input; },
      ingest: async () => assert.fail("evidence must not enter task ingestion"),
    },
  });
  await handler({ kind: "message", text: "提交结果：发布视频｜已发布 3 条", isEvidenceSubmission: true, evidence: [{ type: "text", value: "已发布 3 条" }], senderId: "owner", messageId: "msg-1" });
  assert.equal(submitted.taskId, "task-1");
  assert.equal(submitted.senderId, "owner");
});

test("ignores unauthorized evidence before acceptance routing", async () => {
  const handler = createMessageHandler({
    config: { managerUserId: "owner", feishuReceiveId: "owner" },
    ops: { setSetting() {} }, weeklyPlanning: {},
    manager: {
      listPendingAcceptance: () => assert.fail("unauthorized evidence must not inspect acceptance routing"),
      submitEvidence: async () => assert.fail("unauthorized evidence must not mutate acceptance"),
      ingest: async () => assert.fail("unauthorized evidence must not enter task ingestion"),
    },
  });
  const result = await handler({ kind: "message", text: "", isEvidenceSubmission: true, evidence: [{ type: "feishu_image", value: "img" }], senderId: "intruder", messageId: "msg-2" });
  assert.deepEqual(result, { ignored: true, reason: "different_user" });
});

test("does not route an unrelated ordinary URL message to pending acceptance", async () => {
  let ingested = false;
  const handler = createMessageHandler({
    config: { managerUserId: "owner", feishuReceiveId: "owner" }, ops: { setSetting() {} }, weeklyPlanning: {},
    manager: {
      listPendingAcceptance: () => [{ id: "task-1" }],
      submitEvidence: async () => assert.fail("ordinary URL must not be acceptance evidence"),
      ingest: async () => { ingested = true; },
    },
  });
  await handler({ kind: "message", text: "参考这个链接 https://example.com/article", evidence: [{ type: "url", value: "https://example.com/article" }], isEvidenceSubmission: false, senderId: "owner", messageId: "url-1" });
  assert.equal(ingested, true);
});

test("authorizes evidence acceptance callbacks by card operator", async () => {
  let decisions = 0;
  const callback = createCardActionHandler({
    config: { managerUserId: "owner" },
    manager: { decideAcceptance: async () => { decisions += 1; return { status: "accepted" }; } },
  });
  const denied = await callback({ action: "accept_evidence", taskId: "task-1", actorId: "intruder", idempotencyKey: "card:denied" });
  const allowed = await callback({ action: "accept_evidence", taskId: "task-1", actorId: "owner", idempotencyKey: "card:allowed" });
  assert.equal(denied.ignored, true);
  assert.equal(allowed.toast.content, "验收通过");
  assert.equal(decisions, 1);
});
