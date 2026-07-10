import assert from "node:assert/strict";
import test from "node:test";
import { buildDailySchedule, replanRemaining } from "../src/lib/schedule-engine.mjs";

const settings = {
  timezone: "Asia/Shanghai",
  windows: [["10:00", "12:00"], ["14:00", "18:00"], ["20:00", "22:00"]],
  maxCriticalTasks: 3,
  projectBoosts: [
    { project: "个人IP", points: 100, startsOn: "2026-07-10", endsOn: "2026-07-15" },
  ],
};

test("schedules at most three tasks inside available windows", () => {
  const tasks = Array.from({ length: 5 }, (_, index) => ({
    id: `t${index}`,
    title: `任务${index}`,
    project: "极享OS",
    importance: index === 0 ? "S" : "A",
    urgency: "high",
    quadrant: "重要且紧急",
    estimateMinutes: 120,
    status: "ready",
    procrastinationCount: 0,
    createdAt: `2026-07-0${index + 1}T00:00:00.000Z`,
  }));

  const result = buildDailySchedule({
    date: "2026-07-10",
    now: "2026-07-10T00:30:00.000Z",
    tasks,
    settings,
  });

  assert.equal(new Set(result.blocks.map((block) => block.taskId)).size, 3);
  assert.ok(result.blocks.every((block) => block.startsAt < block.endsAt));
  assert.equal(result.deferred.length, 2);
  assert.equal(result.blocks[0].startsAt, "2026-07-10T02:00:00.000Z");
  assert.equal(result.blocks.at(-1).endsAt, "2026-07-10T10:00:00.000Z");
});

test("applies dated personal-IP boost and preserves doing block during replan", () => {
  const tasks = [
    {
      id: "ip", title: "拍视频", project: "个人IP", importance: "A", urgency: "medium",
      quadrant: "重要不紧急", estimateMinutes: 120, status: "ready", procrastinationCount: 0,
      createdAt: "2026-07-09T00:00:00.000Z",
    },
    {
      id: "os", title: "优化系统", project: "极享OS", importance: "A", urgency: "high",
      quadrant: "重要且紧急", estimateMinutes: 240, status: "ready", procrastinationCount: 0,
      createdAt: "2026-07-08T00:00:00.000Z",
    },
  ];
  const first = buildDailySchedule({
    date: "2026-07-10",
    now: "2026-07-10T00:30:00.000Z",
    tasks,
    settings,
  });
  assert.equal(first.blocks[0].taskId, "ip");

  const current = { ...first.blocks[0], status: "doing" };
  const replanned = replanRemaining({
    schedule: { ...first, blocks: [current, ...first.blocks.slice(1)] },
    now: "2026-07-10T02:15:00.000Z",
    tasks,
    settings,
  });

  assert.equal(replanned.blocks[0].taskId, "ip");
  assert.equal(replanned.blocks[0].startsAt, current.startsAt);
  assert.equal(replanned.blocks[0].status, "doing");
  assert.ok(replanned.blocks.slice(1).every((block) => block.startsAt >= current.endsAt));
});

test("splits a long task across windows without overlap", () => {
  const result = buildDailySchedule({
    date: "2026-07-10",
    now: "2026-07-10T00:30:00.000Z",
    settings,
    tasks: [{
      id: "long", title: "优化系统", project: "极享OS", importance: "S", urgency: "high",
      quadrant: "重要且紧急", estimateMinutes: 360, status: "ready", procrastinationCount: 0,
      createdAt: "2026-07-01T00:00:00.000Z",
    }],
  });

  assert.equal(result.blocks.length, 2);
  assert.equal(result.blocks[0].endsAt, "2026-07-10T04:00:00.000Z");
  assert.equal(result.blocks[1].startsAt, "2026-07-10T06:00:00.000Z");
  assert.equal(result.deferred.length, 0);
});
