import { scoreTaskDetails } from "./prioritizer.mjs";

const ACTIVE_STATUSES = new Set(["inbox", "open", "ready", "scheduled", "doing", "blocked", "deferred"]);

export function buildDailySchedule({ date, now, tasks, settings }) {
  const nowDate = new Date(now);
  const maxCriticalTasks = Number(settings.maxCriticalTasks || 3);
  const windows = buildWindows(date, settings.windows, settings.timezone || "Asia/Shanghai", nowDate);
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
  const selected = ranked.slice(0, maxCriticalTasks);
  const blocks = [];
  const unfinished = new Set();

  let windowIndex = 0;
  for (const item of selected) {
    let remaining = Math.max(5, Number(item.task.estimateMinutes || 30));
    while (remaining > 0 && windowIndex < windows.length) {
      const window = windows[windowIndex];
      if (window.cursor >= window.end) {
        windowIndex += 1;
        continue;
      }
      const available = Math.floor((window.end - window.cursor) / 60_000);
      if (available <= 0) {
        windowIndex += 1;
        continue;
      }
      const minutes = Math.min(remaining, available);
      const start = new Date(window.cursor);
      const end = new Date(window.cursor + minutes * 60_000);
      blocks.push({
        taskId: item.task.id,
        startsAt: start.toISOString(),
        endsAt: end.toISOString(),
        status: item.task.status === "doing" ? "doing" : "planned",
        reason: renderReason(item),
      });
      remaining -= minutes;
      window.cursor = end.getTime();
    }
    if (remaining > 0) unfinished.add(item.task.id);
  }

  const selectedIds = new Set(selected.map((item) => item.task.id));
  const deferred = [
    ...unfinished,
    ...ranked.filter((item) => !selectedIds.has(item.task.id)).map((item) => item.task.id),
  ];
  return {
    date,
    blocks,
    deferred: [...new Set(deferred)],
    reasons: Object.fromEntries(selected.map((item) => [item.task.id, renderReason(item)])),
  };
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

function zonedDateTimeToUtc(date, time, timezone) {
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
