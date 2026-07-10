import assert from "node:assert/strict";
import test from "node:test";
import { openDatabase } from "../src/db/database.mjs";
import { createTaskRepository } from "../src/db/task-repository.mjs";
import { createOperationsRepository } from "../src/db/operations-repository.mjs";
import { recoverManagerState } from "../src/lib/recovery.mjs";

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
