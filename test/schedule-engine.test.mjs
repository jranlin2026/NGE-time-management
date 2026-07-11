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

  assert.equal(result.blocks.length, 3);
  assert.equal(result.blocks[0].endsAt, "2026-07-10T04:00:00.000Z");
  assert.equal(result.blocks[1].startsAt, "2026-07-10T06:00:00.000Z");
  assert.equal(result.deferred.length, 0);
});

test("reserves daily slots for personal IP and Jixiang OS inside their windows", () => {
  const schedule = buildDailySchedule({
    date: "2026-07-11",
    now: "2026-07-11T00:00:00.000Z",
    settings: {
      timezone: "Asia/Shanghai",
      maxCriticalTasks: 5,
      windows: [["10:00", "12:00"], ["14:00", "24:00"]],
      projectMinimums: { "个人IP": 2, "极享OS": 2 },
      projectWindows: {
        "个人IP": [["10:00", "12:00"], ["14:00", "16:00"]],
        "极享OS": [["10:00", "12:00"], ["14:00", "24:00"]],
      },
      projectBoosts: [{ project: "个人IP", points: 100 }],
    },
    tasks: [
      task("ip-1", "个人IP", 60), task("ip-2", "个人IP", 60), task("ip-3", "个人IP", 60),
      task("os-1", "极享OS", 60), task("os-2", "极享OS", 60), task("os-3", "极享OS", 60),
      task("other-1", "行政", 60),
    ],
  });
  const selected = new Set(schedule.blocks.map((block) => block.taskId));
  assert.equal(selected.size, 5);
  assert.equal([...selected].filter((id) => id.startsWith("ip-")).length >= 2, true);
  assert.equal([...selected].filter((id) => id.startsWith("os-")).length >= 2, true);
  for (const block of schedule.blocks.filter((block) => block.taskId.startsWith("ip-"))) {
    const localHour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Shanghai", hour: "2-digit", hourCycle: "h23" }).format(new Date(block.startsAt)));
    assert.equal(localHour === 10 || localHour === 11 || localHour === 14 || localHour === 15, true);
  }
  assert.equal(schedule.blocks.every((block) => (new Date(block.endsAt) - new Date(block.startsAt)) <= 120 * 60_000), true);
});

test("does not schedule personal IP outside its protected window", () => {
  const schedule = buildDailySchedule({
    date: "2026-07-11",
    now: "2026-07-11T00:00:00.000Z",
    settings: {
      timezone: "Asia/Shanghai",
      maxCriticalTasks: 1,
      windows: [["10:00", "12:00"], ["14:00", "24:00"]],
      projectWindows: { "个人IP": [["10:00", "12:00"], ["14:00", "16:00"]] },
    },
    tasks: [task("ip-long", "个人IP", 300)],
  });
  assert.equal(schedule.blocks.length, 2);
  assert.equal(schedule.blocks.every((block) => {
    const hour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Shanghai", hour: "2-digit", hourCycle: "h23" }).format(new Date(block.startsAt)));
    return hour === 10 || hour === 14;
  }), true);
});

function task(id, project, estimateMinutes) {
  return {
    id,
    title: id,
    project,
    status: "ready",
    estimateMinutes,
    importance: "A",
    urgency: "medium",
    createdAt: "2026-07-10T00:00:00.000Z",
  };
}
