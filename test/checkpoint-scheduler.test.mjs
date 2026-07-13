import assert from "node:assert/strict";
import test from "node:test";
import { materializeCheckpointSchedule } from "../src/lib/checkpoint-scheduler.mjs";

const DATE = "2026-07-13";
const TIMEZONE = "Asia/Shanghai";

test("materializes anchored and unanchored checkpoints in checkpoint order", () => {
  const schedule = dailySchedule([
    parentBlock("task-1", "2026-07-13T02:00:00.000Z", "2026-07-13T04:00:00.000Z"),
  ]);
  const task = {
    id: "task-1",
    checkpoints: [
      {
        title: "确定选题",
        minutes: 20,
        startsAt: "2026-07-13T02:15:00.000Z",
        endsAt: "2026-07-13T02:35:00.000Z",
      },
      { title: "写脚本", minutes: 40 },
      { title: "录素材", minutes: 45 },
      {
        title: "提交剪辑",
        minutes: 30,
        startsAt: "2026-07-13T10:30:00.000Z",
        endsAt: "2026-07-13T11:00:00.000Z",
      },
    ],
  };

  const result = materializeCheckpointSchedule({
    schedule,
    tasks: [task],
    date: DATE,
    timezone: TIMEZONE,
  });

  assert.deepEqual(result.blocks.map((block) => block.checkpointIndex), [0, 1, 2, 3]);
  assert.deepEqual(result.blocks.map((block) => [block.startsAt, block.endsAt]), [
    ["2026-07-13T02:15:00.000Z", "2026-07-13T02:35:00.000Z"],
    ["2026-07-13T02:35:00.000Z", "2026-07-13T03:15:00.000Z"],
    ["2026-07-13T03:15:00.000Z", "2026-07-13T04:00:00.000Z"],
    ["2026-07-13T10:30:00.000Z", "2026-07-13T11:00:00.000Z"],
  ]);
});

test("splits unanchored checkpoints sequentially by minutes", () => {
  const schedule = dailySchedule([
    parentBlock("task-2", "2026-07-13T02:00:00.000Z", "2026-07-13T03:30:00.000Z"),
  ]);
  const task = {
    id: "task-2",
    checkpoints: [
      { title: "关卡一", minutes: 15 },
      { title: "关卡二", minutes: 30 },
      { title: "关卡三", minutes: 45 },
    ],
  };

  const result = materializeCheckpointSchedule({
    schedule,
    tasks: [task],
    date: DATE,
    timezone: TIMEZONE,
  });

  assert.deepEqual(result.blocks.map((block) => [block.checkpointIndex, block.startsAt, block.endsAt]), [
    [0, "2026-07-13T02:00:00.000Z", "2026-07-13T02:15:00.000Z"],
    [1, "2026-07-13T02:15:00.000Z", "2026-07-13T02:45:00.000Z"],
    [2, "2026-07-13T02:45:00.000Z", "2026-07-13T03:30:00.000Z"],
  ]);
});

test("skips completed checkpoints without consuming parent capacity", () => {
  const schedule = dailySchedule([
    parentBlock("task-progress", "2026-07-13T02:00:00.000Z", "2026-07-13T03:00:00.000Z"),
  ]);
  const task = {
    id: "task-progress",
    checkpoints: [
      { title: "已完成关卡", minutes: 30, completed: true },
      { title: "剩余关卡", minutes: 30, completed: false },
    ],
  };

  const result = materializeCheckpointSchedule({
    schedule,
    tasks: [task],
    date: DATE,
    timezone: TIMEZONE,
  });

  assert.deepEqual(result.blocks.map((block) => [block.checkpointIndex, block.startsAt, block.endsAt]), [
    [1, "2026-07-13T02:00:00.000Z", "2026-07-13T02:30:00.000Z"],
  ]);
  assert.deepEqual(result.deferred, []);
});

test("consumes multiple parent blocks without duplicating checkpoints", () => {
  const schedule = dailySchedule([
    parentBlock("task-split", "2026-07-13T02:00:00.000Z", "2026-07-13T02:30:00.000Z"),
    parentBlock("task-split", "2026-07-13T03:00:00.000Z", "2026-07-13T03:30:00.000Z"),
  ]);
  const task = {
    id: "task-split",
    checkpoints: [
      { title: "关卡一", minutes: 30 },
      { title: "关卡二", minutes: 30 },
    ],
  };

  const result = materializeCheckpointSchedule({
    schedule,
    tasks: [task],
    date: DATE,
    timezone: TIMEZONE,
  });

  assert.deepEqual(result.blocks.map((block) => [block.checkpointIndex, block.startsAt, block.endsAt]), [
    [0, "2026-07-13T02:00:00.000Z", "2026-07-13T02:30:00.000Z"],
    [1, "2026-07-13T03:00:00.000Z", "2026-07-13T03:30:00.000Z"],
  ]);
});

test("rejects overlapping explicit checkpoint intervals", () => {
  const schedule = dailySchedule([
    parentBlock("task-overlap", "2026-07-13T02:00:00.000Z", "2026-07-13T04:00:00.000Z"),
  ]);
  const task = {
    id: "task-overlap",
    checkpoints: [
      {
        title: "关卡一",
        minutes: 30,
        startsAt: "2026-07-13T02:10:00.000Z",
        endsAt: "2026-07-13T02:40:00.000Z",
      },
      {
        title: "关卡二",
        minutes: 30,
        startsAt: "2026-07-13T02:30:00.000Z",
        endsAt: "2026-07-13T03:00:00.000Z",
      },
    ],
  };

  assert.throws(() => materializeCheckpointSchedule({
    schedule,
    tasks: [task],
    date: DATE,
    timezone: TIMEZONE,
  }), /checkpoint schedule overlaps/);
});

test("does not materialize an explicit checkpoint outside the requested work date", () => {
  const schedule = dailySchedule([
    parentBlock("task-future", "2026-07-13T02:00:00.000Z", "2026-07-13T03:00:00.000Z"),
  ]);
  const task = {
    id: "task-future",
    checkpoints: [{
      title: "明日关卡",
      minutes: 30,
      startsAt: "2026-07-14T02:00:00.000Z",
      endsAt: "2026-07-14T02:30:00.000Z",
    }],
  };

  const result = materializeCheckpointSchedule({
    schedule,
    tasks: [task],
    date: DATE,
    timezone: TIMEZONE,
  });

  assert.deepEqual(result.blocks, []);
  assert.deepEqual(result.deferred, ["task-future"]);
});

test("defers a task instead of overlapping when its final checkpoint does not fit", () => {
  const schedule = dailySchedule([
    parentBlock("task-short", "2026-07-13T02:00:00.000Z", "2026-07-13T02:30:00.000Z"),
  ]);
  const task = {
    id: "task-short",
    checkpoints: [
      { title: "关卡一", minutes: 20 },
      { title: "关卡二", minutes: 20 },
    ],
  };

  const result = materializeCheckpointSchedule({
    schedule,
    tasks: [task],
    date: DATE,
    timezone: TIMEZONE,
  });

  assert.deepEqual(result.blocks.map((block) => block.checkpointIndex), [0]);
  assert.deepEqual(result.deferred, ["task-short"]);
});

test("keeps a task without checkpoints as one legacy block", () => {
  const original = parentBlock(
    "task-legacy",
    "2026-07-13T02:00:00.000Z",
    "2026-07-13T03:00:00.000Z",
  );
  const schedule = dailySchedule([original]);

  const result = materializeCheckpointSchedule({
    schedule,
    tasks: [{ id: "task-legacy", checkpoints: [] }],
    date: DATE,
    timezone: TIMEZONE,
  });

  assert.deepEqual(result.blocks, [{ ...original, checkpointIndex: null }]);
  assert.deepEqual(result.deferred, []);
});

test("moves stale explicit anchors around future anchors inside remaining capacity", () => {
  const schedule = dailySchedule([
    parentBlock("task-stale", "2026-07-13T10:00:00.000Z", "2026-07-13T11:00:00.000Z"),
  ]);
  const task = {
    id: "task-stale",
    checkpoints: [
      {
        title: "补做开播检查",
        minutes: 15,
        startsAt: "2026-07-13T02:00:00.000Z",
        endsAt: "2026-07-13T02:15:00.000Z",
      },
      {
        title: "检查中场数据",
        minutes: 15,
        startsAt: "2026-07-13T10:00:00.000Z",
        endsAt: "2026-07-13T10:15:00.000Z",
      },
    ],
  };

  const result = materializeCheckpointSchedule({
    schedule,
    tasks: [task],
    date: DATE,
    timezone: TIMEZONE,
    now: "2026-07-13T10:00:00.000Z",
  });

  assert.deepEqual(result.blocks.map((block) => [block.checkpointIndex, block.startsAt, block.endsAt]), [
    [1, "2026-07-13T10:00:00.000Z", "2026-07-13T10:15:00.000Z"],
    [0, "2026-07-13T10:15:00.000Z", "2026-07-13T10:30:00.000Z"],
  ]);
  assert.deepEqual(result.deferred, []);
});

test("completed explicit checkpoints keep history and do not consume stale replan capacity", () => {
  const schedule = dailySchedule([
    parentBlock("task-history", "2026-07-13T06:00:00.000Z", "2026-07-13T06:30:00.000Z"),
  ]);
  const task = {
    id: "task-history",
    checkpoints: [
      {
        title: "已完成上午检查",
        minutes: 15,
        startsAt: "2026-07-13T02:00:00.000Z",
        endsAt: "2026-07-13T02:15:00.000Z",
        completed: true,
      },
      {
        title: "补做上午记录",
        minutes: 30,
        startsAt: "2026-07-13T02:15:00.000Z",
        endsAt: "2026-07-13T02:45:00.000Z",
      },
    ],
  };

  const result = materializeCheckpointSchedule({
    schedule,
    tasks: [task],
    date: DATE,
    timezone: TIMEZONE,
    now: "2026-07-13T04:00:00.000Z",
  });

  assert.deepEqual(result.blocks.map((block) => [block.checkpointIndex, block.startsAt, block.endsAt]), [
    [1, "2026-07-13T06:00:00.000Z", "2026-07-13T06:30:00.000Z"],
  ]);
});

function dailySchedule(blocks) {
  return { date: DATE, blocks, deferred: [], reasons: {}, capacityWarnings: [] };
}

function parentBlock(taskId, startsAt, endsAt) {
  return { taskId, startsAt, endsAt, status: "planned", reason: "test schedule" };
}
