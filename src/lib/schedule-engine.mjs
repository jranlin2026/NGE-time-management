import { scoreTaskDetails } from "./prioritizer.mjs";

const ACTIVE_STATUSES = new Set(["inbox", "open", "ready", "scheduled", "doing", "blocked", "deferred"]);

export function buildDailySchedule({ date, now, tasks, settings }) {
  const nowDate = new Date(now);
  const maxCriticalTasks = normalizedMaxCriticalTasks(settings.maxCriticalTasks);
  const futureTasks = tasks.filter((task) => ACTIVE_STATUSES.has(task.status || "ready") && !isDueBy(task, date));
  const ranked = tasks
    .filter((task) => ACTIVE_STATUSES.has(task.status || "ready") && isDueBy(task, date))
    .map((task) => {
      const details = scoreTaskDetails(task, nowDate, {
        date,
        projectBoosts: settings.projectBoosts || [],
      });
      const overrideScore = task.project === "极享OS" && task.impact === "system_unusable_bug" ? 10_000 : 0;
      return { task, ...details, score: details.score + overrideScore };
    })
    .filter((item) => item.score > -100)
    .sort(compareRanked);
  const candidates = orderRankedTasks(ranked, settings.projectMinimums || {});
  const blocks = [];
  const capacityLimitMinutes = Math.max(0, Math.floor(
    settings.capacityLimitMinutes ?? windowMinutes(settings.windows) * Number(settings.capacityRatio || 1),
  ));
  const budgetRemaining = () => capacityLimitMinutes - blocks.reduce(blockMinutes, 0);
  const unfinished = new Set();
  const scheduled = [];
  for (const item of candidates) {
    if (scheduled.length >= maxCriticalTasks) break;
    let remaining = Math.max(5, Number(item.task.estimateMinutes || 30));
    const definitions = settings.projectWindows?.[item.task.project] || settings.windows;
    while (remaining > 0) {
      const slot = nextAvailableSlot({ date, now: nowDate, definitions, timezone: settings.timezone || "Asia/Shanghai", occupied: blocks });
      if (!slot) break;
      const available = Math.floor((slot.end - slot.start) / 60_000);
      if (available <= 0) break;
      const minutes = Math.min(remaining, available, 120, budgetRemaining());
      if (minutes <= 0) break;
      const start = new Date(slot.start);
      const end = new Date(slot.start + minutes * 60_000);
      blocks.push({
        taskId: item.task.id,
        startsAt: start.toISOString(),
        endsAt: end.toISOString(),
        status: item.task.status === "doing" ? "doing" : "planned",
        reason: renderReason(item),
      });
      remaining -= minutes;
    }
    const added = blocks.some((block) => block.taskId === item.task.id);
    if (added) scheduled.push(item);
    if (remaining > 0) unfinished.add(item.task.id);
  }

  const selectedIds = new Set(scheduled.map((item) => item.task.id));
  const deferred = [
    ...unfinished,
    ...ranked.filter((item) => !selectedIds.has(item.task.id)).map((item) => item.task.id),
    ...futureTasks.map((task) => task.id),
  ];
  const capacityWarnings = capacityWarningsFor({ blocks, tasks, settings });
  return {
    date,
    blocks,
    deferred: [...new Set(deferred)],
    reasons: Object.fromEntries(scheduled.map((item) => [item.task.id, renderReason(item)])),
    capacityWarnings,
  };
}

function isDueBy(task, date) {
  if (!task.dueAt) return true;
  return String(task.dueAt).slice(0, 10) <= date;
}

function orderRankedTasks(ranked, projectMinimums) {
  const selected = [];
  const selectedIds = new Set();
  for (const item of ranked) {
    if (item.task.project !== "极享OS" || item.task.impact !== "system_unusable_bug") continue;
    selected.push(item);
    selectedIds.add(item.task.id);
  }
  const minimumEntries = Object.entries(projectMinimums).sort(([left], [right]) => {
    if (left === "个人IP") return -1;
    if (right === "个人IP") return 1;
    return 0;
  });
  for (const [project, minimum] of minimumEntries) {
    for (const item of ranked) {
      if (item.task.project !== project || selectedIds.has(item.task.id)) continue;
      selected.push(item);
      selectedIds.add(item.task.id);
      if (selected.filter((candidate) => candidate.task.project === project).length >= minimum) break;
    }
  }
  for (const item of ranked) {
    if (selectedIds.has(item.task.id)) continue;
    selected.push(item);
    selectedIds.add(item.task.id);
  }
  return selected;
}

export function replanRemaining({ schedule, now, tasks, settings }) {
  const current = schedule.blocks.find((block) => block.status === "doing");
  if (!current) {
    return buildDailySchedule({ date: schedule.date, now, tasks, settings });
  }

  const currentTask = tasks.find((task) => task.id === current.taskId);
  const currentMinutes = Math.max(
    0,
    Math.round((new Date(current.endsAt) - new Date(current.startsAt)) / 60_000),
  );
  const remainingCurrentMinutes = Math.max(
    0,
    Number(currentTask?.estimateMinutes || 0) - currentMinutes,
  );
  const candidates = tasks
    .filter((task) => task.id !== current.taskId)
    .concat(
      remainingCurrentMinutes > 0
        ? [{ ...currentTask, status: "ready", estimateMinutes: remainingCurrentMinutes }]
        : [],
    );
  const effectiveNow = new Date(
    Math.max(new Date(now).getTime(), new Date(current.endsAt).getTime()),
  ).toISOString();
  const remainingLimit = Math.max(
    0,
    normalizedMaxCriticalTasks(settings.maxCriticalTasks) - 1 + (remainingCurrentMinutes > 0 ? 1 : 0),
  );
  const replanned = buildDailySchedule({
    date: schedule.date,
    now: effectiveNow,
    tasks: candidates,
    settings: {
      ...settings,
      maxCriticalTasks: remainingLimit,
      capacityLimitMinutes: Math.max(
        0,
        Math.floor(windowMinutes(settings.windows) * Number(settings.capacityRatio || 1)) - currentMinutes,
      ),
    },
  });
  const blocks = [current, ...replanned.blocks];
  return {
    ...replanned,
    blocks,
    deferred: [...new Set(replanned.deferred)],
    capacityWarnings: capacityWarningsFor({ blocks, tasks, settings }),
  };
}

function normalizedMaxCriticalTasks(value) {
  const parsed = Number(value ?? 3);
  if (!Number.isFinite(parsed)) return 3;
  return Math.min(5, Math.max(0, Math.trunc(parsed)));
}

function blockMinutes(sum, block) {
  return sum + (new Date(block.endsAt) - new Date(block.startsAt)) / 60_000;
}

function minutesBetweenClockTimes(start, end) {
  const [startHour, startMinute] = start.split(":").map(Number);
  const [endHour, endMinute] = end.split(":").map(Number);
  return (endHour * 60 + endMinute) - (startHour * 60 + startMinute);
}

function windowMinutes(definitions = []) {
  return definitions.reduce((sum, [start, end]) => sum + minutesBetweenClockTimes(start, end), 0);
}

function capacityWarningsFor({ blocks, tasks, settings }) {
  const minimumMinutes = Number(settings.projectMinimumMinutes || 0);
  if (minimumMinutes <= 0) return [];
  const projectByTaskId = new Map(tasks.map((task) => [task.id, task.project]));
  const scheduledMinutes = new Map();
  const scheduledTasks = new Map();
  for (const block of blocks) {
    const project = projectByTaskId.get(block.taskId);
    scheduledMinutes.set(project, (scheduledMinutes.get(project) || 0) + blockMinutes(0, block));
    if (!scheduledTasks.has(project)) scheduledTasks.set(project, new Set());
    scheduledTasks.get(project).add(block.taskId);
  }
  return Object.entries(settings.projectMinimums || {})
    .filter(([project, count]) => (scheduledTasks.get(project)?.size || 0) < Number(count)
      || (scheduledMinutes.get(project) || 0) < minimumMinutes)
    .map(([project, count]) => `${project} 最低要求 ${Number(count)} 个任务且共 ${minimumMinutes} 分钟无法在容量上限内排入`);
}

function buildWindows(date, definitions, timezone, now) {
  return (definitions || [])
    .map(([start, end]) => ({
      start: zonedDateTimeToUtc(date, start, timezone).getTime(),
      end: zonedDateTimeToUtc(date, end, timezone).getTime(),
    }))
    .filter((window) => window.end > now.getTime())
    .map((window) => ({
      ...window,
      cursor: Math.max(window.start, now.getTime()),
    }));
}

function nextAvailableSlot({ date, now, definitions, timezone, occupied }) {
  const windows = buildWindows(date, definitions, timezone, now)
    .sort((left, right) => left.start - right.start);
  const sortedOccupied = occupied
    .map((block) => ({ start: new Date(block.startsAt).getTime(), end: new Date(block.endsAt).getTime() }))
    .sort((left, right) => left.start - right.start);
  for (const window of windows) {
    let cursor = window.cursor;
    for (const block of sortedOccupied) {
      if (block.end <= cursor || block.start >= window.end) continue;
      if (block.start > cursor) return { start: cursor, end: Math.min(block.start, window.end) };
      cursor = Math.max(cursor, block.end);
      if (cursor >= window.end) break;
    }
    if (cursor < window.end) return { start: cursor, end: window.end };
  }
  return null;
}

export function zonedDateTimeToUtc(date, time, timezone) {
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  const guessedUtc = Date.UTC(year, month - 1, day, hour, minute);
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(new Date(guessedUtc)).map((part) => [part.type, part.value]),
  );
  const representedAsUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  const offset = representedAsUtc - guessedUtc;
  return new Date(guessedUtc - offset);
}

function compareRanked(left, right) {
  if (right.score !== left.score) return right.score - left.score;
  const leftDue = left.task.dueAt || left.task.due || "9999-12-31";
  const rightDue = right.task.dueAt || right.task.due || "9999-12-31";
  if (leftDue !== rightDue) return leftDue.localeCompare(rightDue);
  const leftCreated = left.task.createdAt || left.task.created || "";
  const rightCreated = right.task.createdAt || right.task.created || "";
  if (leftCreated !== rightCreated) return leftCreated.localeCompare(rightCreated);
  return String(left.task.id).localeCompare(String(right.task.id));
}

function renderReason(item) {
  const factors = item.factors.slice(0, 2).map((factor) => factor.label);
  return factors.length ? factors.join("、") : `综合评分 ${item.score}`;
}
