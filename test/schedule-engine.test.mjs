import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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

test("does not hang when a protected window has less than one minute remaining", () => {
  const moduleUrl = new URL("../src/lib/schedule-engine.mjs", import.meta.url).href;
  const script = `
    import { buildDailySchedule } from ${JSON.stringify(moduleUrl)};
    const result = buildDailySchedule({
      date: "2026-07-11",
      now: "2026-07-11T07:00:41.000Z",
      settings: {
        timezone: "Asia/Shanghai",
        maxCriticalTasks: 1,
        windows: [["14:00", "16:00"]],
        projectWindows: { "个人IP": [["14:00", "16:00"]] },
      },
      tasks: [{
        id: "ip-long", title: "个人IP", project: "个人IP", status: "ready",
        estimateMinutes: 120, importance: "A", urgency: "medium",
        createdAt: "2026-07-10T00:00:00.000Z",
      }],
    });
    if (result.blocks.length !== 1) process.exit(2);
  `;

  assert.doesNotThrow(() => execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    timeout: 750,
    stdio: "pipe",
  }));
});

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

test("caps scheduled work at seventy percent of usable windows", () => {
  const schedule = buildDailySchedule({
    date: "2026-07-13",
    now: "2026-07-13T00:00:00.000Z",
    settings: {
      timezone: "Asia/Shanghai",
      windows: [["10:00", "12:00"], ["14:00", "18:00"], ["20:00", "22:00"]],
      capacityRatio: 0.7,
      maxCriticalTasks: 5,
    },
    tasks: Array.from({ length: 5 }, (_, index) => task(`long-${index}`, "极享OS", 240)),
  });
  const minutes = schedule.blocks.reduce((sum, block) =>
    sum + (new Date(block.endsAt) - new Date(block.startsAt)) / 60_000, 0);
  assert.equal(minutes, 336);
  assert.ok(minutes <= 480 * 0.7);
});

test("only a system-unusable Jixiang OS bug overrides normal ranking", () => {
  const base = {
    date: "2026-07-13",
    now: "2026-07-13T00:00:00.000Z",
    settings: {
      timezone: "Asia/Shanghai", windows: [["10:00", "12:00"]], maxCriticalTasks: 1,
      capacityRatio: 0.7, projectBoosts: [{ project: "个人IP", points: 100 }],
    },
  };
  const ipTask = task("ip", "个人IP", 60);
  const normalOs = task("normal-os", "极享OS", 60);
  const unusableOs = { ...task("unusable-os", "极享OS", 60), impact: "system_unusable_bug" };

  assert.equal(buildDailySchedule({ ...base, tasks: [ipTask, normalOs] }).blocks[0].taskId, ipTask.id);
  assert.equal(buildDailySchedule({ ...base, tasks: [ipTask, unusableOs] }).blocks[0].taskId, unusableOs.id);
});

test("warns when project minimum work cannot fit without exceeding capacity", () => {
  const schedule = buildDailySchedule({
    date: "2026-07-13",
    now: "2026-07-13T00:00:00.000Z",
    settings: {
      timezone: "Asia/Shanghai", windows: [["10:00", "11:00"]], capacityRatio: 0.7,
      maxCriticalTasks: 5, projectMinimums: { "个人IP": 2 }, projectMinimumMinutes: 120,
    },
    tasks: [task("ip-1", "个人IP", 60), task("ip-2", "个人IP", 60)],
  });
  const minutes = schedule.blocks.reduce((sum, block) =>
    sum + (new Date(block.endsAt) - new Date(block.startsAt)) / 60_000, 0);
  assert.equal(minutes, 42);
  assert.equal(schedule.capacityWarnings.length, 1);
  assert.match(schedule.capacityWarnings[0], /个人IP/);
});

test("best effort satisfies two tasks and 120 total minutes per project when feasible", () => {
  const schedule = buildDailySchedule({
    date: "2026-07-13", now: "2026-07-13T00:00:00.000Z",
    settings: { timezone: "Asia/Shanghai", windows: [["10:00", "18:00"]], capacityRatio: 0.7,
      maxCriticalTasks: 5, projectMinimums: { "个人IP": 2, "极享OS": 2 }, projectMinimumMinutes: 120 },
    tasks: [task("ip-1", "个人IP", 30), task("ip-2", "个人IP", 90), task("os-1", "极享OS", 60), task("os-2", "极享OS", 60), task("admin", "行政", 120)],
  });
  const ids = new Set(schedule.blocks.map((block) => block.taskId));
  assert.equal([...ids].filter((id) => id.startsWith("ip-")).length, 2);
  assert.equal([...ids].filter((id) => id.startsWith("os-")).length, 2);
  assert.deepEqual(schedule.capacityWarnings, []);
});

test("clamps configured critical tasks to five in initial builds and replans", () => {
  const oversizedSettings = {
    timezone: "Asia/Shanghai", windows: [["10:00", "24:00"]], capacityRatio: 1,
    maxCriticalTasks: 99, projectMinimums: {},
  };
  const tasks = Array.from({ length: 8 }, (_, index) => task(`task-${index}`, "行政", 30));
  const initial = buildDailySchedule({
    date: "2026-07-13", now: "2026-07-13T00:00:00.000Z", tasks, settings: oversizedSettings,
  });
  assert.equal(new Set(initial.blocks.map((block) => block.taskId)).size, 5);

  const current = { ...initial.blocks[0], status: "doing" };
  const replanned = replanRemaining({
    schedule: { ...initial, blocks: [current] },
    now: "2026-07-13T02:15:00.000Z",
    tasks: tasks.map((item) => item.id === current.taskId ? { ...item, status: "doing" } : item),
    settings: oversizedSettings,
  });
  assert.equal(new Set(replanned.blocks.map((block) => block.taskId)).size, 5);
});

test("preserved current work counts toward capacity but one task still warns on a two-task minimum", () => {
  const settings = {
    timezone: "Asia/Shanghai", windows: [["10:00", "18:00"]], capacityRatio: 0.7,
    maxCriticalTasks: 5, projectMinimums: { "个人IP": 2 }, projectMinimumMinutes: 60,
  };
  const currentTask = task("current-ip", "个人IP", 120);
  const current = {
    taskId: currentTask.id, startsAt: "2026-07-13T02:00:00.000Z", endsAt: "2026-07-13T04:00:00.000Z",
    status: "doing", reason: "正在执行",
  };
  const replanned = replanRemaining({
    schedule: { date: "2026-07-13", blocks: [current] },
    now: "2026-07-13T02:15:00.000Z",
    tasks: [currentTask, task("os-long", "极享OS", 300)],
    settings,
  });
  const minutes = replanned.blocks.reduce((sum, block) =>
    sum + (new Date(block.endsAt) - new Date(block.startsAt)) / 60_000, 0);
  assert.equal(replanned.capacityWarnings.some((warning) => warning.includes("个人IP")), true);
  assert.ok(minutes <= 480 * 0.7);
});

test("project minimum key order cannot promote normal OS work over personal IP", () => {
  const settings = {
    timezone: "Asia/Shanghai", windows: [["10:00", "18:00"]], capacityRatio: 0.7,
    maxCriticalTasks: 5, projectMinimums: { "极享OS": 2, "个人IP": 2 }, projectMinimumMinutes: 60,
  };
  const ip = task("ip", "个人IP", 60);
  const normalOs = task("normal-os", "极享OS", 60);
  const unusableOs = { ...task("unusable-os", "极享OS", 60), impact: "system_unusable_bug" };

  assert.equal(buildDailySchedule({
    date: "2026-07-13", now: "2026-07-13T00:00:00.000Z", tasks: [normalOs, ip], settings,
  }).blocks[0].taskId, ip.id);
  assert.equal(buildDailySchedule({
    date: "2026-07-13", now: "2026-07-13T00:00:00.000Z", tasks: [ip, unusableOs], settings,
  }).blocks[0].taskId, unusableOs.id);
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
