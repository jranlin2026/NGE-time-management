import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createManagerRuntime } from "../src/manager-app.mjs";

test("one day flows from merged DMs through subtasks and review", async (t) => {
  const day = e2eFixture();
  t.after(() => day.close());
  day.feishu.addDirectMessages([
    message("om-1", "想到一个选题：老板为什么要学Codex", "2026-07-13T00:10:00.000Z"),
    message("om-2", "用我们买CRM花一万元的经历", "2026-07-13T00:20:00.000Z"),
  ]);
  await day.runner.run({ now: "2026-07-13T09:00:00+08:00" });
  assert.equal(day.feishu.privateReplies.length, 1);
  assert.equal(day.feishu.parentTasks.length, 0);

  day.seedConfirmedDailyTask();
  await day.runner.run({ now: "2026-07-13T12:00:00+08:00" });
  assert.equal(day.feishu.parentTasks.length, 1);
  assert.equal(day.feishu.subtasks.length, 3);

  day.feishu.completeSubtask(0, "2026-07-13T04:30:00.000Z");
  await day.runner.run({ now: "2026-07-13T15:00:00+08:00" });
  assert.equal(day.tasks.findById("task-video").checkpoints[0].completed, true);
  assert.match(day.events.find((event) => event.kind === "checkpoint_completed").idempotencyKey, /^feishu-checkpoint:child-/);

  await day.runner.run({ now: "2026-07-13T15:00:00+08:00" });
  assert.equal(day.events.filter((event) => event.kind === "checkpoint_completed").length, 1);

  day.feishu.completeParent("2026-07-13T13:00:00.000Z");
  await day.runner.run({ now: "2026-07-13T21:00:00+08:00" });
  assert.equal(day.tasks.findById("task-video").status, "pending_acceptance");

  await day.runner.run({ now: "2026-07-14T00:00:00+08:00" });
  const review = day.ops.getReview("2026-07-13");
  assert.match(review.renderedText, /今日复盘/);
  assert.match(review.renderedText, /完成主任务：0\/1/);
  assert.match(review.renderedText, /完成子任务：1\/3/);
});

function e2eFixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "checkpoint-e2e-"));
  const messages = [];
  const privateReplies = [];
  const parentTasks = [];
  const subtasks = [];
  let guid = 0;
  const api = {
    async listTasklistTasks() { return parentTasks; },
    async listSubtasks(_config, parentGuid) { return subtasks.filter((task) => task.parent_guid === parentGuid); },
    async createTask(_config, body) {
      const task = { guid: `parent-${++guid}`, client_token: body.clientToken, ...body };
      parentTasks.push(task);
      return { data: { task } };
    },
    async createSubtask(_config, parentGuid, body) {
      const task = { guid: `child-${++guid}`, parent_guid: parentGuid, client_token: body.clientToken, ...body };
      subtasks.push(task);
      return { data: { task } };
    },
    async updateTask(_config, taskGuid, body) { Object.assign([...parentTasks, ...subtasks].find((task) => task.guid === taskGuid), body); },
  };
  const analyzer = {
    async analyzeCheckpointMessages({ messages: inbound }) {
      if (!inbound.length) return { items: [] };
      return {
        items: [{
          messageIds: inbound.map((item) => item.messageId),
          category: "idea",
          disposition: "candidate_pool",
          title: "老板为什么要学 Codex：一万元 CRM 经历",
          rationale: "没有明确截止时间，先进入候选池",
        }],
      };
    },
    async analyzeTask() { throw new Error("ordinary task analysis is outside this E2E"); },
  };
  const runtime = createManagerRuntime({
    dbPath: ":memory:",
    kbDir: directory,
    backupDir: directory,
    markdownExportDir: directory,
    timezone: "Asia/Shanghai",
    managerUserId: "ou-owner",
    feishuReceiveId: "ou-owner",
    feishuReceiveIdType: "open_id",
    feishuTasklistGuid: "tasklist-1",
    schedule: {
      weeklyPlan: "22:00", plan: "08:00", firstTask: "10:00", midday: "12:00",
      afternoon: "14:00", dayClose: "18:00", eveningStart: "20:00", eveningEnd: "24:00", noResponseMinutes: 10,
    },
  }, {
    analyzer,
    feishuTaskApi: api,
    resolveChatId: async () => "oc-p2p",
    pollMessages: async ({ startTime, endTime }) => messages.filter((item) => {
      const seconds = Date.parse(item.createdAt) / 1000;
      return seconds > (startTime ?? -Infinity) && seconds <= endTime;
    }),
    sendOutbox: async (row) => {
      if (row.kind === "private_checkpoint_summary") privateReplies.push(row.payload);
      return { messageId: `reply-${privateReplies.length}` };
    },
  });
  const runner = {
    run({ now }) {
      const local = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(now));
      return runtime.checkpointRunner.run({ now, forcedNode: local === "00:00" ? "24:00" : local });
    },
  };
  return {
    ...runtime,
    runner,
    get events() { return runtime.ops.listEvents(); },
    feishu: {
      messages, privateReplies, parentTasks, subtasks,
      addDirectMessages(items) { messages.push(...items); },
      completeSubtask(index, completedAt) { subtasks[index].completed_at = String(Date.parse(completedAt)); },
      completeParent(completedAt) { parentTasks[0].completed_at = String(Date.parse(completedAt)); },
    },
    seedConfirmedDailyTask() {
      runtime.tasks.create({
        id: "task-video",
        title: "完成老板为什么要学 Codex 口播",
        project: "个人IP",
        projectId: "personal-ip",
        status: "doing",
        requiresEvidence: true,
        estimateMinutes: 90,
        checkpoints: [
          { title: "写脚本", minutes: 30 },
          { title: "录制", minutes: 30 },
          { title: "剪辑发布", minutes: 30 },
        ],
      });
      runtime.ops.replaceSchedule({ date: "2026-07-13", blocks: [{
        taskId: "task-video", startsAt: "2026-07-13T02:00:00.000Z", endsAt: "2026-07-13T03:30:00.000Z", reason: "confirmed_daily_task",
      }] });
    },
    close() { runtime.db.close(); fs.rmSync(directory, { recursive: true, force: true }); },
  };
}

function message(messageId, text, createdAt) {
  return { messageId, chatId: "oc-p2p", senderId: "ou-owner", messageType: "text", content: { text }, createdAt };
}
