import { scoreTaskDetails } from "./prioritizer.mjs";

const ACTIVE_STATUSES = new Set(["inbox", "open", "ready", "scheduled", "doing", "blocked", "deferred"]);

export function buildDailySchedule({ date, now, tasks, settings }) {
  const nowDate = new Date(now);
  const maxCriticalTasks = Number(settings.maxCriticalTasks || 3);
  const ranked = tasks
    .filter((task) => ACTIVE_STATUSES.has(task.status || "ready"))
    .map((task) => {
      const details = scoreTaskDetails(task, nowDate, {
        date,
        projectBoosts: settings.projectBoosts || [],
      });
      return { task, ...details };
    })
    .filter((item) => item.score > -100)
    .sort(compareRanked);
  const candidates = orderRankedTasks(ranked, settings.projectMinimums || {});
  const blocks = [];
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
      const minutes = Math.min(remaining, available, 120);
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
  ];
  return {
    date,
    blocks,
    deferred: [...new Set(deferred)],
    reasons: Object.fromEntries(scheduled.map((item) => [item.task.id, renderReason(item)])),
  };
}

function orderRankedTasks(ranked, projectMinimums) {
  const selected = [];
  const selectedIds = new Set();
  for (const [project, minimum] of Object.entries(projectMinimums)) {
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
    Number(settings.maxCriticalTasks || 3) - 1 + (remainingCurrentMinutes > 0 ? 1 : 0),
  );
  const replanned = buildDailySchedule({
    date: schedule.date,
    now: effectiveNow,
    tasks: candidates,
    settings: { ...settings, maxCriticalTasks: remainingLimit },
  });
  return {
    ...replanned,
    blocks: [current, ...replanned.blocks],
    deferred: [...new Set(replanned.deferred)],
  };
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
