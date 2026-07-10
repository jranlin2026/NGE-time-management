import assert from "node:assert/strict";
import test from "node:test";
import { openDatabase, withTransaction } from "../src/db/database.mjs";
import { createTaskRepository } from "../src/db/task-repository.mjs";
import { createOperationsRepository } from "../src/db/operations-repository.mjs";
import { createReminderEngine } from "../src/lib/reminder-engine.mjs";
import { createManagerService } from "../src/lib/manager-service.mjs";
import { buildDailyReview } from "../src/lib/daily-review.mjs";

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
