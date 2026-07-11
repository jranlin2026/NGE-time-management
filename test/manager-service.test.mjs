import assert from "node:assert/strict";
import test from "node:test";
import { openDatabase, withTransaction } from "../src/db/database.mjs";
import { createTaskRepository } from "../src/db/task-repository.mjs";
import { createOperationsRepository } from "../src/db/operations-repository.mjs";
import { createManagerService } from "../src/lib/manager-service.mjs";

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
