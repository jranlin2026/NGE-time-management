import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createManagerRuntime } from "../src/manager-app.mjs";

test("08:00 private reply is a full brief in the configured local timezone", async (t) => {
  const day = e2eFixture({
    timezone: "Asia/Tokyo",
    clockNow: "2026-07-13T08:00:00+09:00",
  });
  t.after(() => day.close());
  day.seedConfirmedDailyTask();

  await day.runner.run({ now: "2026-07-13T08:00:00+09:00" });

  assert.equal(day.feishu.privateReplies.length, 1);
  const text = day.feishu.privateReplies[0].text;
  assert.match(text, /11:00–11:30/);
  assert.match(text, /今天按这个节奏走/);
  assert.match(text, /做到：提交可发布的口播视频/);
  assert.match(text, /卡住了直接回我卡在哪/);
});

test("one day flows from merged DMs through subtasks and review", async (t) => {
  const day = e2eFixture();
  t.after(() => day.close());
  day.seedConfirmedDailyTask();
  const doingBefore = day.tasks.findById("task-video");
  const scheduleBefore = scheduleShape(day.ops.currentSchedule("2026-07-13"));
  day.feishu.addDirectMessages([
    message("om-1", "想到一个选题：老板为什么要学Codex", "2026-07-13T00:10:00.000Z"),
    message("om-2", "用我们买CRM花一万元的经历", "2026-07-13T00:20:00.000Z"),
  ]);
  await day.runner.run({ now: "2026-07-13T09:00:00+08:00" });
  assert.equal(day.feishu.privateReplies.length, 1);
  assert.equal(day.tasks.findById("task-video").status, doingBefore.status);
  assert.deepEqual(scheduleShape(day.ops.currentSchedule("2026-07-13")), scheduleBefore);
  assert.equal(day.tasks.listAll().length, 1);
  assert.equal(day.events.some((event) => event.kind === "interrupt_current"), false);
  assert.equal(day.feishu.parentTasks.some((task) => task.summary.includes("老板为什么要学 Codex：一万元 CRM 经历")), false);

  await day.runner.run({ now: "2026-07-13T12:00:00+08:00" });
  assert.equal(day.feishu.parentTasks.length, 1);
  assert.equal(day.feishu.subtasks.length, 3);

  day.feishu.completeSubtask(0, "2026-07-13T04:30:00.000Z");
  await day.runner.run({ now: "2026-07-13T15:00:00+08:00" });
  assert.equal(day.tasks.findById("task-video").checkpoints[0].completed, true);
  assert.match(day.events.find((event) => event.kind === "checkpoint_completed").idempotencyKey, /^feishu-checkpoint:child-/);

  day.feishu.completeParent("2026-07-13T07:30:00.000Z");
  await day.runner.run({ now: "2026-07-13T18:00:00+08:00" });
  assert.equal(day.events.filter((event) => event.kind === "checkpoint_completed").length, 1);
  assert.equal(day.tasks.findById("task-video").status, "pending_acceptance");

  await day.runner.run({ now: "2026-07-13T21:00:00+08:00" });
  assert.equal(day.tasks.findById("task-video").status, "pending_acceptance");

  day.feishu.addDirectMessages([
    message("om-proof", "已发布 https://example.com/video", "2026-07-13T14:00:00.000Z"),
  ]);
  await day.runner.run({ now: "2026-07-14T00:00:00+08:00" });
  assert.equal(day.tasks.findById("task-video").status, "done");
  assert.match(fs.readFileSync(path.join(day.directory, "项目", "个人IP.md"), "utf8"), /video-01.*accepted.*https:\/\/example\.com\/video/);
  assert.equal(fs.readdirSync(path.join(day.directory, "项目变更记录")).length, 1);
  const review = day.ops.getReview("2026-07-13");
  assert.match(review.renderedText, /今日复盘/);
  assert.match(review.renderedText, /完成主任务：1\/1/);
  assert.match(review.renderedText, /完成子任务：1\/3/);
});

test("15:00 catch-up of the 12:00 node never republishes work before execution", async (t) => {
  const day = e2eFixture();
  t.after(() => day.close());
  day.seedConfirmedDailyTask();
  day.feishu.addDirectMessages([
    message("om-catch-up", "想到一个稍后验证的新选题", "2026-07-13T04:10:00.000Z"),
  ]);

  await day.checkpointRunner.run({
    now: "2026-07-13T15:00:00+08:00",
    forcedNode: "12:00",
  });

  const blocks = day.ops.currentSchedule("2026-07-13");
  assert.ok(blocks.length > 0);
  assert.equal(blocks.some((block) => block.startsAt < "2026-07-13T07:00:00.000Z"), false);
  assert.equal(day.feishu.subtasks.some((task) => task.startAt && task.startAt < "2026-07-13T07:00:00.000Z"), false);
});

function e2eFixture({ timezone = "Asia/Shanghai", clockNow = "2026-07-13T08:00:00+08:00" } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "checkpoint-e2e-"));
  writeProject(directory);
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
      if (inbound.some((item) => item.messageId === "om-proof")) return {
        items: [{
          messageIds: ["om-proof"], category: "evidence", disposition: "evidence_submission",
          taskId: null, evidence: { messageIds: ["om-proof"], text: "已发布", links: ["https://example.com/video"] },
          title: "发布证据", projectId: "personal-ip", urgency: "low", mustBeOwner: true,
          estimateMinutes: 15, dueAt: null, nextAction: "核验发布链接", doneDefinition: "链接可访问",
          checkpoints: [{ title: "核验发布链接", minutes: 15 }], rationale: "用户提交了可见链接",
        }],
      };
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
    async analyzeAcceptance() { return { status: "accepted", explanation: "发布链接与交付项相关" }; },
  };
  let currentClock = new Date(clockNow);
  const runtime = createManagerRuntime({
    dbPath: ":memory:",
    kbDir: directory,
    backupDir: directory,
    markdownExportDir: directory,
    timezone,
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
    clock: { now: () => new Date(currentClock) },
    feishuTaskApi: api,
    resolveChatId: async () => "oc-p2p",
    pollMessages: async ({ startTime, endTime }) => messages.filter((item) => {
      const seconds = Date.parse(item.createdAt) / 1000;
      return seconds > (startTime ?? -Infinity) && seconds <= endTime;
    }),
    sendOutbox: async (row) => {
      if (["feishu_task_create", "feishu_task_update"].includes(row.kind)) {
        assert.fail(`legacy task outbox reached checkpoint flow: ${row.kind}`);
      }
      if (row.kind === "private_checkpoint_summary") privateReplies.push(row.payload);
      return { messageId: `reply-${privateReplies.length}` };
    },
  });
  const runner = {
    run({ now }) {
      currentClock = new Date(now);
      const local = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(now));
      return runtime.checkpointRunner.run({ now, forcedNode: local === "00:00" ? "24:00" : local });
    },
  };
  return {
    ...runtime, directory,
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
        milestoneId: "content-validation",
        deliverableId: "video-01",
        status: "doing",
        requiresEvidence: true,
        doneDefinition: "提交可发布的口播视频",
        estimateMinutes: 90,
        checkpoints: [
          { title: "写脚本", minutes: 30 },
          { title: "录制", minutes: 30 },
          { title: "剪辑发布", minutes: 30 },
        ],
      });
      runtime.ops.replaceSchedule({ date: "2026-07-13", blocks: [
        {
          taskId: "task-video", checkpointIndex: 0,
          startsAt: "2026-07-13T02:00:00.000Z", endsAt: "2026-07-13T02:30:00.000Z",
          status: "doing", reason: "confirmed_daily_task",
        },
        {
          taskId: "task-video", checkpointIndex: 1,
          startsAt: "2026-07-13T02:30:00.000Z", endsAt: "2026-07-13T03:00:00.000Z",
          status: "planned", reason: "confirmed_daily_task",
        },
        {
          taskId: "task-video", checkpointIndex: 2,
          startsAt: "2026-07-13T03:00:00.000Z", endsAt: "2026-07-13T03:30:00.000Z",
          status: "planned", reason: "confirmed_daily_task",
        },
      ] });
    },
    close() { runtime.db.close(); fs.rmSync(directory, { recursive: true, force: true }); },
  };
}

function writeProject(root) {
  const projectDir = path.join(root, "项目");
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, "个人IP.md"), `---
project_id: personal-ip
name: 个人IP
status: active
priority: 1
updated_at: 2026-07-12T08:00:00+08:00
---

# 个人IP

<!-- time-manager:managed:start -->
## 当前阶段

内容冷启动

## 里程碑

| milestone_id | 名称 | 截止时间 | 项目权重 | 状态 |
| --- | --- | --- | ---: | --- |
| content-validation | 验证内容方向 | 2026-07-31 | 100 | active |

## 里程碑交付项

| deliverable_id | milestone_id | 交付项 | 里程碑权重 | 状态 | 验收证据 |
| --- | --- | --- | ---: | --- | --- |
| video-01 | content-validation | 发布第 1 条短视频 | 100 | pending | |

## 当前风险

- 暂无。

## 下一步候选

- 发布短视频。

## 最近一次实质成果

尚无。
<!-- time-manager:managed:end -->
`, "utf8");
}

function message(messageId, text, createdAt) {
  return { messageId, chatId: "oc-p2p", senderId: "ou-owner", messageType: "text", content: { text }, createdAt };
}

function scheduleShape(blocks) {
  return blocks.map(({ taskId, checkpointIndex, startsAt, endsAt, status }) => (
    { taskId, checkpointIndex, startsAt, endsAt, status }
  ));
}
