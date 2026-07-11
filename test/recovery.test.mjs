import assert from "node:assert/strict";
import test from "node:test";
import { openDatabase } from "../src/db/database.mjs";
import { createTaskRepository } from "../src/db/task-repository.mjs";
import { createOperationsRepository } from "../src/db/operations-repository.mjs";
import { recoverManagerState } from "../src/lib/recovery.mjs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createManagerApp } from "../src/manager-app.mjs";
import { createProjectMarkdownRepository } from "../src/lib/project-markdown-repository.mjs";

test("invalidates stale reminders, preserves future reminders, and sends one recovery plan", async () => {
  const now = "2026-07-10T06:30:00.000Z";
  let sequence = 0;
  const id = () => `id-${++sequence}`;
  const db = openDatabase(":memory:");
  const tasks = createTaskRepository(db, { now: () => now, id });
  const ops = createOperationsRepository(db, { now: () => now, id });
  tasks.create({ id: "task-1", rawInput: "优化系统", status: "doing" });
  ops.enqueueReminder({ kind: "task_start", dueAt: "2026-07-10T05:00:00.000Z", idempotencyKey: "old" });
  ops.enqueueReminder({ kind: "midday", dueAt: "2026-07-10T07:00:00.000Z", idempotencyKey: "future" });
  ops.enqueueReminder({ kind: "old_plan", dueAt: "2026-07-10T06:00:00.000Z", expiresAt: "2026-07-10T06:15:00.000Z", idempotencyKey: "expired" });
  let replans = 0;

  const result = await recoverManagerState({
    now,
    date: "2026-07-10",
    tasks,
    ops,
    replan: async () => {
      replans += 1;
      return { version: 2, blocks: [{ taskId: "task-1" }] };
    },
  });

  assert.equal(replans, 1);
  assert.equal(result.currentTask.id, "task-1");
  assert.equal(ops.listReminders({ status: "pending" }).length, 1);
  assert.equal(ops.listReminders({ status: "expired" }).length, 2);
  assert.equal(ops.listOutbox().filter((row) => row.kind === "recovery_plan_card").length, 1);

  await recoverManagerState({ now, date: "2026-07-10", tasks, ops, replan: async () => ({ version: 2, blocks: [] }) });
  assert.equal(ops.listOutbox().filter((row) => row.kind === "recovery_plan_card").length, 1);
  db.close();
});

test("reconciles project state before publishing the recovered plan", async () => {
  const now = "2026-07-12T01:00:00.000Z";
  const db = openDatabase(":memory:");
  const tasks = createTaskRepository(db, { now: () => now });
  const ops = createOperationsRepository(db, { now: () => now });
  let calls = 0;

  await recoverManagerState({
    now, date: "2026-07-12", tasks, ops,
    reconcileProjects: async () => { calls += 1; return [{ projectId: "personal-ip", acceptanceId: "acceptance-1" }]; },
    replan: async () => ({ version: 1, blocks: [] }),
  });

  assert.equal(calls, 1);
  assert.equal(ops.listEvents({ kind: "project_sync_reconciled" }).length, 1);
  db.close();
});

test("two app starts deterministically finalize a manually accepted image after a Markdown-write crash", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "manager-recovery-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dbPath = path.join(root, "manager.sqlite");
  const baseRepo = createProjectMarkdownRepository({ kbDir: root });
  await baseRepo.ensureDraftTemplates([{
    projectId: "personal-ip", name: "个人IP", milestoneId: "launch", milestoneName: "启动",
    deliverableId: "first", deliverableName: "首个交付项",
  }]);
  const draft = await baseRepo.readProject("personal-ip");
  await baseRepo.confirmDraft("personal-ip", draft.contentHash);
  let failAfterMarkdown = true;
  const crashingRepo = createProjectMarkdownRepository({
    kbDir: root,
    failureInjector(point) {
      if (failAfterMarkdown && point === "after_markdown_write") {
        failAfterMarkdown = false;
        throw new Error("crash after accepted Markdown write");
      }
    },
  });
  const config = recoveryAppConfig(root, dbPath);
  const noConnector = async () => ({ stop: async () => {} });
  const app1 = createManagerApp(config, { projectRepo: crashingRepo, connectFeishu: noConnector, setInterval: () => 1, clearInterval() {} });
  const task = app1.state.tasks.create({
    id: "manual-image", title: "提交首个交付项", status: "doing", requiresEvidence: true,
    project: "个人IP", projectId: "personal-ip", milestoneId: "launch", deliverableId: "first",
  });
  const requested = await app1.state.acceptance.request(task, { idempotencyKey: "request-image" });
  await app1.state.acceptance.submit({
    taskId: task.id, evidence: [{ type: "feishu_image", value: "img_v2_manual" }],
    idempotencyKey: "submit-image",
  });

  await assert.rejects(() => app1.state.acceptance.decideByUser({
    acceptanceId: requested.id, decision: "accepted", explanation: "人工已查看",
    idempotencyKey: "manual-image-accept",
  }), /crash after accepted Markdown write/);
  const required = app1.state.ops.listEvents({ kind: "project_sync_reconciliation_required" })[0];
  assert.equal(required.payload.decision, "accepted");
  assert.deepEqual(required.payload.evidence, [{ type: "feishu_image", value: "img_v2_manual" }]);
  assert.equal(required.payload.operationKey, `acceptance-${requested.id}`);
  await app1.stop();

  let analyzerCalls = 0;
  const analyzer = { analyzeAcceptance: async () => { analyzerCalls += 1; throw new Error("recovery must not analyze"); } };
  for (let run = 0; run < 2; run += 1) {
    const app = createManagerApp(config, {
      analyzer, connectFeishu: noConnector, setInterval: () => 1, clearInterval() {},
    });
    await app.start();
    assert.equal(app.state.tasks.findById("manual-image").status, "done");
    assert.equal(app.state.ops.listEvents({ kind: "task_accepted" }).length, 1);
    assert.equal(app.state.ops.listEvents({ kind: "project_sync_reconciled" }).length, 1);
    assert.equal(app.state.ops.listOutbox().filter((row) => row.kind === "project_progress_card").length, 1);
    await app.stop();
  }
  const receipts = (await fs.readdir(path.join(root, "项目变更记录"))).filter((name) => name.endsWith(".json"));
  assert.equal(receipts.length, 1);
  assert.equal(analyzerCalls, 0);
});

function recoveryAppConfig(root, dbPath) {
  return {
    dbPath, dataDir: root, kbDir: root, backupDir: path.join(root, "backups"), markdownExportDir: path.join(root, "exports"),
    timezone: "Asia/Shanghai", feishuReceiveId: "owner", managerUserId: "owner", capacityRatio: 0.7,
    schedule: { weeklyPlan: "22:00", plan: "08:00", firstTask: "10:00", midday: "12:00", afternoon: "14:00", dayClose: "18:00", eveningStart: "20:00", eveningEnd: "24:00", noResponseMinutes: 10 },
  };
}
