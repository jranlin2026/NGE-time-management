import assert from "node:assert/strict";
import test from "node:test";
import { openDatabase, withTransaction } from "../src/db/database.mjs";
import { createTaskRepository } from "../src/db/task-repository.mjs";
import { createOperationsRepository } from "../src/db/operations-repository.mjs";
import { createProjectOperationsRepository } from "../src/db/project-operations-repository.mjs";
import { createReminderEngine } from "../src/lib/reminder-engine.mjs";
import { createManagerService } from "../src/lib/manager-service.mjs";
import { buildDailyReview } from "../src/lib/daily-review.mjs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createManagerApp } from "../src/manager-app.mjs";

test("composed app runs weekly plan through evidence acceptance and project progress", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "manager-loop-e2e-"));
  await fs.mkdir(path.join(root, "项目"), { recursive: true });
  await fs.writeFile(path.join(root, "项目", "个人IP.md"), `---
project_id: personal-ip
name: 个人IP
status: active
priority: 1
updated_at: 2026-07-12T08:00:00+08:00
---

# 个人IP

<!-- time-manager:managed:start -->
## 当前阶段

内容验证

## 里程碑

| milestone_id | 名称 | 截止时间 | 项目权重 | 状态 |
| --- | --- | --- | ---: | --- |
| content-validation | 内容验证 | 2026-07-31 | 100 | active |

## 里程碑交付项

| deliverable_id | milestone_id | 交付项 | 里程碑权重 | 状态 | 验收证据 |
| --- | --- | --- | ---: | --- | --- |
| video-01 | content-validation | 发布首条短视频 | 10 | pending | |
| remaining | content-validation | 后续内容 | 90 | pending | |

## 当前风险

- 暂无。

## 下一步候选

- 发布首条短视频。

## 最近一次实质成果

尚无。
<!-- time-manager:managed:end -->
`, "utf8");
  const analyzer = {
    analyzeWeeklyPlan: async ({ weekId }) => ({ weekId, outcomes: ["发布首条短视频"], deliverableChanges: [], tasks: [{
      taskId: "publish-video-01", projectId: "personal-ip", projectName: "个人IP",
      milestoneId: "content-validation", deliverableId: "video-01", deliverable: "发布首条短视频",
      title: "发布首条短视频", suggestedDate: "2026-07-13", requiresEvidence: true,
      impact: "high", minutes: 90, date: "2026-07-13", completionStandard: "公开视频上线",
    }] }),
    analyzeAcceptance: async () => ({ status: "accepted", explanation: "链接证据有效" }),
  };
  const app = createManagerApp({
    dbPath: ":memory:", dataDir: root, kbDir: root, backupDir: path.join(root, "backups"), markdownExportDir: path.join(root, "exports"),
    timezone: "Asia/Shanghai", feishuReceiveId: "owner", managerUserId: "owner", capacityRatio: 0.7,
    schedule: { weeklyPlan: "22:00", plan: "08:00", firstTask: "10:00", midday: "12:00", afternoon: "14:00", dayClose: "18:00", eveningStart: "20:00", eveningEnd: "24:00", noResponseMinutes: 10 },
  }, { analyzer });

  await app.state.weeklyPlanning.generateDraft({ weekId: "2026-W29" });
  await app.state.weeklyPlanning.confirm({ weekId: "2026-W29", version: 1, eventId: "confirm-1" });
  await app.state.manager.dispatchDay({ date: "2026-07-13", now: "2026-07-13T00:00:00.000Z" });
  const task = app.state.tasks.listActive().find((item) => item.deliverableId === "video-01");
  await app.state.manager.handleAction({ action: "start", taskId: task.id, idempotencyKey: "start-1" });
  await app.state.manager.handleAction({ action: "complete", taskId: task.id, idempotencyKey: "complete-1" });
  await app.state.acceptance.submit({ taskId: task.id, evidence: [{ type: "url", value: "https://example.com/v/1" }], idempotencyKey: "evidence-1" });

  assert.equal(app.state.tasks.findById(task.id).status, "done");
  assert.equal((await app.state.projectRepo.readProject("personal-ip")).progress, 10);
  assert.equal((await fs.readdir(path.join(root, "项目变更记录"))).filter((name) => name.endsWith(".json")).length, 1);
  await app.stop();
  await fs.rm(root, { recursive: true, force: true });
});

test("runs plan, two-stage no-response, replan, midday, close, and review", async () => {
  let now = new Date("2026-07-10T00:30:00.000Z");
  let sequence = 0;
  const id = () => `id-${++sequence}`;
  const db = openDatabase(":memory:");
  const tasks = createTaskRepository(db, { now: () => now.toISOString(), id });
  const ops = createOperationsRepository(db, { now: () => now.toISOString(), id });
  tasks.create({
    id: "task-1", title: "拍 3 条口播", rawInput: "拍 3 条口播", project: "个人IP",
    status: "ready", importance: "A", urgency: "high", quadrant: "重要且紧急",
    estimateMinutes: 120, nextAction: "打开第一条提纲", doneDefinition: "交 3 条素材",
  });
  const settings = {
    timezone: "Asia/Shanghai",
    windows: [["10:00", "12:00"], ["14:00", "18:00"], ["20:00", "22:00"]],
    maxCriticalTasks: 3,
    noResponseMinutes: 15,
    projectBoosts: [],
  };
  let manager;
  const analyzer = {
    minimumAction: async () => ({ action: "打开相机完整说一遍", minutes: 15 }),
    analyzeTask: async () => { throw new Error("not used"); },
  };
  const reminderEngine = createReminderEngine({
    tasks,
    ops,
    analyzer,
    replan: (input) => manager.replanDay({ reason: input.reason, now: input.now }),
    clock: { now: () => now },
  });
  manager = createManagerService({
    db,
    transaction: (fn) => withTransaction(db, fn),
    tasks,
    ops,
    analyzer,
    reminderEngine,
    clock: { now: () => now },
    settings,
  });

  await manager.dispatchDay({ date: "2026-07-10", now: now.toISOString() });
  now = new Date("2026-07-10T02:31:00.000Z");
  await reminderEngine.processDue();
  now = new Date("2026-07-10T04:00:00.000Z");
  await manager.runMiddayCheck({ date: "2026-07-10", now: now.toISOString() });
  now = new Date("2026-07-10T10:00:00.000Z");
  await manager.runDayClose({ date: "2026-07-10", now: now.toISOString() });

  const summary = buildDailyReview({
    date: "2026-07-10",
    tasks: tasks.listActive(),
    schedule: { blocks: ops.currentSchedule("2026-07-10") },
    events: ops.listEvents(),
  });
  ops.saveReview({ date: "2026-07-10", summary, renderedText: "review" });
  ops.appendEvent({ kind: "daily_review_created", payload: summary, idempotencyKey: "review:2026-07-10" });

  const kinds = ops.listEvents().map((event) => event.kind);
  for (const expected of [
    "daily_plan_created",
    "task_start_reminded",
    "no_response_1",
    "procrastination_recorded",
    "schedule_replanned",
    "midday_checked",
    "day_closed",
    "daily_review_created",
  ]) {
    assert.ok(kinds.includes(expected), `missing ${expected}`);
  }
  assert.equal(ops.getReview("2026-07-10").date, "2026-07-10");
  db.close();
});

test("daily dispatch materializes the confirmed weekly plan before scheduling", async () => {
  const now = new Date("2026-07-13T00:30:00.000Z");
  const db = openDatabase(":memory:");
  const tasks = createTaskRepository(db, { now: () => now.toISOString() });
  const ops = createOperationsRepository(db, { now: () => now.toISOString() });
  const projectOps = createProjectOperationsRepository(db, { now: () => now.toISOString() });
  projectOps.saveWeeklyPlan({
    weekId: "2026-W29", version: 1, status: "confirmed", markdownPath: "week.md", contentHash: "hash",
    plan: { tasks: [{
      taskId: "publish-video-01", projectId: "personal-ip", projectName: "个人IP",
      milestoneId: "content-validation", deliverableId: "video-01", title: "发布首条短视频",
      suggestedDate: "2026-07-13", requiresEvidence: true, impact: "high",
      estimateMinutes: 90, nextAction: "剪出初版", completionStandard: "公开视频上线",
    }] },
  });
  const settings = {
    timezone: "Asia/Shanghai", windows: [["10:00", "12:00"]], capacityRatio: 0.7,
    maxCriticalTasks: 3, noResponseMinutes: 15, projectBoosts: [], projectMinimums: {},
  };
  const reminderEngine = { scheduleTask() {} };
  const manager = createManagerService({
    db, transaction: (fn) => withTransaction(db, fn), tasks, ops, projectOps,
    analyzer: {}, reminderEngine, clock: { now: () => now }, settings,
  });

  const schedule = await manager.dispatchDay({ date: "2026-07-13", now: now.toISOString() });

  assert.equal(tasks.findById("weekly:2026-W29:publish-video-01").deliverableId, "video-01");
  assert.equal(schedule.blocks[0].taskId, "weekly:2026-W29:publish-video-01");
  await manager.dispatchDay({ date: "2026-07-13", now: now.toISOString() });
  assert.equal(tasks.listAll().filter((task) => task.deliverableId === "video-01").length, 1);
  db.close();
});

test("manager replan keeps the current doing block stable", async () => {
  const now = new Date("2026-07-13T02:15:00.000Z");
  const db = openDatabase(":memory:");
  const tasks = createTaskRepository(db, { now: () => now.toISOString() });
  const ops = createOperationsRepository(db, { now: () => now.toISOString() });
  tasks.create({ id: "current", title: "当前任务", project: "个人IP", status: "doing", estimateMinutes: 120 });
  tasks.create({ id: "next", title: "下一任务", project: "极享OS", status: "ready", estimateMinutes: 120 });
  const current = {
    taskId: "current", startsAt: "2026-07-13T02:00:00.000Z", endsAt: "2026-07-13T04:00:00.000Z",
    status: "doing", reason: "正在执行",
  };
  ops.replaceSchedule({ date: "2026-07-13", blocks: [current] });
  const manager = createManagerService({
    tasks, ops, analyzer: {}, reminderEngine: { scheduleTask() {} }, clock: { now: () => now },
    settings: {
      timezone: "Asia/Shanghai", windows: [["10:00", "12:00"], ["14:00", "18:00"]],
      capacityRatio: 0.7, maxCriticalTasks: 3, projectBoosts: [], projectMinimums: {},
    },
  });

  const replanned = await manager.replanDay({ date: "2026-07-13", now: now.toISOString() });

  assert.equal(replanned.blocks[0].taskId, current.taskId);
  assert.equal(replanned.blocks[0].startsAt, current.startsAt);
  assert.equal(replanned.blocks[0].endsAt, current.endsAt);
  assert.equal(replanned.blocks[0].status, "doing");
  db.close();
});
