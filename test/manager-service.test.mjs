import assert from "node:assert/strict";
import test from "node:test";
import { openDatabase, withTransaction } from "../src/db/database.mjs";
import { createTaskRepository } from "../src/db/task-repository.mjs";
import { createOperationsRepository } from "../src/db/operations-repository.mjs";
import { createManagerService } from "../src/lib/manager-service.mjs";
import { createCheckpointPolicy } from "../src/lib/checkpoint-policy.mjs";

const NOW = "2026-07-10T00:30:00.000Z";

function setup(overrides = {}) {
  let sequence = 0;
  const id = () => `id-${++sequence}`;
  const db = openDatabase(":memory:");
  const tasks = createTaskRepository(db, { now: () => NOW, id });
  const ops = createOperationsRepository(db, { now: () => NOW, id });
  const scheduled = [];
  const manager = createManagerService({
    db,
    transaction: (fn) => withTransaction(db, fn),
    tasks,
    ops,
    analyzer: {
      analyzeTask: async () => ({
        title: "拍摄 3 条 Codex 口播",
        project: "个人IP",
        quadrant: "重要且紧急",
        importance: "A",
        urgency: "high",
        dueAt: "2026-07-10T10:00:00.000Z",
        estimateMinutes: 120,
        nextAction: "打开第一条提纲开始录制",
        doneDefinition: "3 条素材交给剪辑",
        analysisStatus: "complete",
      }),
      minimumAction: async () => ({ action: "先完整说一遍", minutes: 15 }),
    },
    reminderEngine: { scheduleTask: (...args) => scheduled.push(args) },
    clock: { now: () => new Date(NOW) },
    settings: {
      timezone: "Asia/Shanghai",
      windows: [["10:00", "12:00"], ["14:00", "18:00"], ["20:00", "22:00"]],
      maxCriticalTasks: 3,
      noResponseMinutes: 15,
      projectBoosts: [{ project: "个人IP", points: 100, startsOn: "2026-07-10", endsOn: "2026-07-15" }],
    },
    ...overrides,
  });
  return { db, tasks, ops, manager, scheduled };
}

test("ingests one natural-language task, analyzes it, and ignores duplicate message", async () => {
  const { db, tasks, ops, manager } = setup();
  const first = await manager.ingest({
    messageId: "om-100",
    text: "今天拍 3 条 Codex 口播",
    senderId: "user-1",
  });
  const duplicate = await manager.ingest({
    messageId: "om-100",
    text: "今天拍 3 条 Codex 口播",
    senderId: "user-1",
  });

  assert.equal(first.id, duplicate.id);
  assert.equal(tasks.listActive().length, 1);
  assert.equal(tasks.findById(first.id).status, "scheduled");
  assert.deepEqual(
    ops.listEvents({ taskId: first.id }).map((event) => event.kind).slice(0, 2),
    ["task_created", "task_analyzed"],
  );
  assert.equal(ops.listOutbox().filter((row) => row.kind === "task_ack").length, 1);
  db.close();
});

test("completes a task and replans future blocks", async () => {
  const { db, tasks, ops, manager } = setup();
  const task = tasks.create({ id: "task-1", rawInput: "拍视频", title: "拍视频", status: "doing" });
  const result = await manager.handleAction({ action: "complete", taskId: task.id, idempotencyKey: "card:evt-1" });

  assert.equal(result.task.status, "done");
  assert.equal(ops.listEvents({ taskId: task.id }).some((event) => event.kind === "task_completed"), true);
  assert.equal(ops.listOutbox().some((row) => row.kind === "status_message"), true);
  assert.equal(ops.findEventByIdempotencyKey("card:evt-1").kind, "task_completed");
  db.close();
});

test("requires evidence before completing a project deliverable", async () => {
  const { db, tasks, ops, manager } = setup();
  const task = tasks.create({ id: "critical", rawInput: "发布视频", title: "发布视频", status: "doing", requiresEvidence: true });
  const result = await manager.handleAction({ action: "complete", taskId: task.id, idempotencyKey: "complete-1" });

  assert.equal(result.action, "evidence_required");
  assert.equal(tasks.findById(task.id).status, "pending_acceptance");
  assert.equal(ops.listOutbox().at(-1).kind, "evidence_request_card");
  db.close();
});

test("task_dm replanning keeps schedule side effects but does not enqueue a task card", async () => {
  const { db, tasks, ops, manager, scheduled } = setup();
  tasks.create({ id: "quiet-plan", rawInput: "安静排程", status: "ready" });

  const result = await manager.replanDay({ date: "2026-07-10", now: NOW, reason: "checkpoint_09:00", deliveryMode: "task_dm" });

  assert.ok(result.blocks.length > 0);
  assert.ok(scheduled.length > 0);
  assert.equal(ops.listOutbox().some((row) => ["daily_plan_card", "replan_card"].includes(row.kind)), false);
  assert.equal(ops.listEvents().some((event) => event.kind === "schedule_replanned"), true);
  db.close();
});

test("12:00 policy puts a new today disposition into the real capacity-limited schedule", async () => {
  const { db, tasks, ops, manager } = setup();
  const policy = createCheckpointPolicy({ manager, tasks });

  const result = await policy.apply({
    node: "12:00", workDate: "2026-07-10", messages: [{ messageId: "om-real-12" }],
    remoteProgress: { completedParents: [], completedCheckpoints: [] },
    analysis: { items: [{
      disposition: "schedule_today", title: "真实午间排程", estimateMinutes: 30,
      checkpoints: [{ title: "导出午间脚本", minutes: 30 }],
    }] },
  });

  assert.equal(result.schedule.blocks.some((block) => block.taskId === tasks.findByTitle("真实午间排程")[0].id), true);
  assert.equal(ops.listOutbox().some((row) => row.kind === "replan_card"), false);
  db.close();
});

test("15:00 policy preserves real doing work and schedules the new today task", async () => {
  const { db, tasks, manager } = setup();
  const doing = tasks.create({ id: "real-doing", rawInput: "当前核心任务", status: "doing", estimateMinutes: 30 });
  await manager.replanDay({ date: "2026-07-10", now: NOW, deliveryMode: "task_dm" });
  const policy = createCheckpointPolicy({ manager, tasks });

  const result = await policy.apply({
    node: "15:00", workDate: "2026-07-10", messages: [{ messageId: "om-real-15" }],
    remoteProgress: { completedParents: [], completedCheckpoints: [] },
    analysis: { items: [{
      disposition: "schedule_today", title: "真实下午排程", estimateMinutes: 30,
      checkpoints: [{ title: "导出下午交付", minutes: 30 }],
    }] },
  });

  const created = tasks.findByTitle("真实下午排程")[0];
  assert.equal(result.schedule.blocks[0].taskId, doing.id);
  assert.equal(result.schedule.blocks.some((block) => block.taskId === created.id), true);
  db.close();
});

test("silent task_dm action queues no standalone owner message", async () => {
  const { db, tasks, ops, manager } = setup();
  tasks.create({ id: "remote-done", rawInput: "远端完成", status: "doing" });

  await manager.handleAction({ action: "complete", taskId: "remote-done", idempotencyKey: "feishu-parent:1", deliveryMode: "task_dm", suppressOutbox: true });

  assert.equal(ops.listOutbox().some((row) => row.kind === "replan_card"), false);
  assert.equal(ops.listOutbox().some((row) => row.kind === "status_message"), false);
  db.close();
});

test("silent evidence-gated completion preserves acceptance without an evidence card", async () => {
  const { db, tasks, ops, manager } = setup();
  tasks.create({ id: "silent-evidence", rawInput: "证据交付", status: "doing", requiresEvidence: true });

  const result = await manager.handleAction({ action: "complete", taskId: "silent-evidence", idempotencyKey: "feishu-parent:evidence", deliveryMode: "task_dm", suppressOutbox: true });

  assert.equal(result.action, "evidence_required");
  assert.equal(tasks.findById("silent-evidence").status, "pending_acceptance");
  assert.equal(ops.listOutbox().some((row) => row.kind === "evidence_request_card"), false);
  db.close();
});

test("silent checkpoint completion queues no standalone status", async () => {
  const { db, tasks, ops, manager } = setup();
  tasks.create({ id: "silent-child", rawInput: "关卡", status: "doing", checkpoints: ["写脚本"] });

  await manager.handleAction({ action: "complete_checkpoint", taskId: "silent-child", checkpointIndex: 0, idempotencyKey: "feishu-child:1", suppressOutbox: true });

  assert.equal(tasks.findById("silent-child").checkpoints[0].completed, true);
  assert.equal(ops.listOutbox().some((row) => row.kind === "status_message"), false);
  db.close();
});

test("completes one checkpoint without completing the parent task", async () => {
  const { db, tasks, ops, manager } = setup();
  const task = tasks.create({
    id: "task-checkpoint",
    rawInput: "拍摄口播",
    status: "doing",
    checkpoints: ["写脚本", "录制素材"],
  });
  const result = await manager.handleAction({
    action: "complete_checkpoint",
    taskId: task.id,
    checkpointIndex: 0,
    idempotencyKey: "card:checkpoint-1",
  });

  assert.equal(result.task.status, "doing");
  assert.equal(result.task.checkpoints[0].completed, true);
  assert.equal(result.task.checkpoints[1].completed, false);
  assert.equal(ops.listEvents({ taskId: task.id }).some((event) => event.kind === "checkpoint_completed"), true);
  db.close();
});

test("requires a reason before deferring a task", async () => {
  const { db, tasks, ops, manager } = setup();
  const task = tasks.create({ id: "task-defer", rawInput: "拍视频", status: "doing" });
  const result = await manager.handleAction({ action: "defer_30", taskId: task.id, idempotencyKey: "message:defer-1" });

  assert.equal(result.action, "defer_reason_required");
  assert.equal(tasks.findById(task.id).status, "doing");
  assert.match(ops.listOutbox().at(-1).payload.text, /说明推迟原因/);
  db.close();
});

test("does not start a second task while one is doing", async () => {
  const { db, tasks, ops, manager } = setup();
  tasks.create({ id: "current", rawInput: "当前任务", status: "doing" });
  tasks.create({ id: "next", rawInput: "下一个任务", status: "ready" });
  const result = await manager.handleAction({ action: "start", taskId: "next", idempotencyKey: "card:evt-2" });

  assert.equal(result.action, "current_task_conflict");
  assert.equal(tasks.findById("next").status, "ready");
  assert.equal(ops.listOutbox().at(-1).kind, "current_task_conflict");
  db.close();
});

test("starting the current doing task is idempotent and gives visible feedback", async () => {
  const { db, tasks, ops, manager } = setup();
  tasks.create({ id: "current", title: "拍视频", rawInput: "拍视频", status: "doing" });

  const result = await manager.handleAction({
    action: "start",
    taskId: "current",
    idempotencyKey: "card:evt-repeat-start",
  });

  assert.equal(result.action, "already_started");
  assert.equal(result.task.status, "doing");
  assert.match(ops.listOutbox().at(-1).payload.text, /已经在进行中/);
  db.close();
});

test("asks for disambiguation when a text title matches two tasks", async () => {
  const { db, tasks, ops, manager } = setup();
  tasks.create({ id: "a", title: "拍视频第一批", rawInput: "拍视频第一批", status: "ready" });
  tasks.create({ id: "b", title: "拍视频第二批", rawInput: "拍视频第二批", status: "ready" });
  const result = await manager.handleAction({ action: "complete", query: "拍视频", idempotencyKey: "message:om-2" });

  assert.equal(result.action, "disambiguation");
  assert.equal(tasks.findById("a").status, "ready");
  assert.equal(tasks.findById("b").status, "ready");
  assert.equal(ops.listOutbox().at(-1).kind, "disambiguation_card");
  db.close();
});

test("blocks proactively without counting procrastination and creates minimum action", async () => {
  const { db, tasks, ops, manager } = setup();
  tasks.create({ id: "task-3", title: "写口播", rawInput: "写口播", status: "doing", procrastinationCount: 0 });
  const result = await manager.handleAction({
    action: "block",
    taskId: "task-3",
    detail: "AI感强",
    idempotencyKey: "message:om-3",
  });

  assert.equal(result.task.status, "blocked");
  assert.equal(result.task.procrastinationCount, 0);
  assert.equal(ops.listOutbox().some((row) => row.kind === "intervention_card"), true);
  db.close();
});
