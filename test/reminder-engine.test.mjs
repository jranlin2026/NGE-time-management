import assert from "node:assert/strict";
import test from "node:test";
import { openDatabase } from "../src/db/database.mjs";
import { createTaskRepository } from "../src/db/task-repository.mjs";
import { createOperationsRepository } from "../src/db/operations-repository.mjs";
import { createReminderEngine } from "../src/lib/reminder-engine.mjs";

test("second no-response records procrastination, creates one intervention, and replans once", async () => {
  let now = "2026-07-10T02:00:00.000Z";
  let sequence = 0;
  const id = () => `id-${++sequence}`;
  const db = openDatabase(":memory:");
  const tasks = createTaskRepository(db, { now: () => now, id });
  const ops = createOperationsRepository(db, { now: () => now, id });
  const task = tasks.create({
    id: "task-1",
    title: "拍 3 条视频",
    rawInput: "拍 3 条视频",
    status: "scheduled",
    nextAction: "打开第一条提纲",
  });
  let replans = 0;
  const engine = createReminderEngine({
    tasks,
    ops,
    analyzer: { minimumAction: async () => ({ action: "打开相机，把第一条完整说一遍", minutes: 15 }) },
    replan: async () => { replans += 1; },
    clock: { now: () => new Date(now) },
  });
  engine.scheduleTask(task, "2026-07-10T02:00:00.000Z", 1, 15);

  now = "2026-07-10T02:31:00.000Z";
  assert.equal(await engine.processDue(), 3);
  assert.equal(tasks.findById("task-1").procrastinationCount, 1);
  assert.equal(replans, 1);
  assert.deepEqual(
    ops.listEvents({ taskId: "task-1" }).map((event) => event.kind),
    ["task_start_reminded", "no_response_1", "procrastination_recorded"],
  );
  assert.deepEqual(
    ops.listOutbox().map((row) => row.kind),
    ["current_task_card", "no_response_message", "intervention_card"],
  );
  assert.equal(ops.listOutbox()[1].payload.mentionOwner, true);
  assert.match(ops.listOutbox()[2].payload.coachText, /效率/);
  assert.equal(ops.listReminders({ status: "pending" }).length, 0);
  db.close();
});

test("skips no-response chase after task already started", async () => {
  const now = "2026-07-10T02:31:00.000Z";
  let sequence = 0;
  const id = () => `id-${++sequence}`;
  const db = openDatabase(":memory:");
  const tasks = createTaskRepository(db, { now: () => now, id });
  const ops = createOperationsRepository(db, { now: () => now, id });
  const task = tasks.create({ id: "task-2", rawInput: "优化系统", status: "doing" });
  const engine = createReminderEngine({ tasks, ops, analyzer: {}, replan: async () => {}, clock: { now: () => new Date(now) } });
  engine.scheduleTask(task, "2026-07-10T02:00:00.000Z", 1, 15);

  await engine.processDue();
  assert.equal(ops.listOutbox().filter((row) => row.kind === "no_response_message").length, 0);
  assert.equal(tasks.findById("task-2").procrastinationCount, 0);
  db.close();
});
