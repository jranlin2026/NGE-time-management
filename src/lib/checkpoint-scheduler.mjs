export function materializeCheckpointSchedule({ schedule, tasks, date, timezone, now }) {
  const byId = new Map((tasks || []).map((task) => [task.id, task]));
  const parentBlocksByTask = groupBlocksByTask(schedule.blocks || []);
  const selectedTaskIds = new Set(parentBlocksByTask.keys());
  const nowTimestamp = optionalTimestamp(now);
  const reservedIntervals = collectCurrentAndFutureAnchors({
    tasks,
    selectedTaskIds,
    parentBlocksByTask,
    date,
    timezone,
    nowTimestamp,
  });
  const materializedTaskIds = new Set();
  const deferred = new Set(schedule.deferred || []);
  const output = [];

  for (const parentBlock of schedule.blocks || []) {
    const task = byId.get(parentBlock.taskId);
    const checkpoints = task?.checkpoints || [];
    if (!checkpoints.length) {
      output.push({ ...parentBlock, checkpointIndex: null });
      continue;
    }
    if (materializedTaskIds.has(task.id)) continue;
    materializedTaskIds.add(task.id);

    const materialized = materializeTaskCheckpoints({
      task,
      parentBlocks: parentBlocksByTask.get(task.id),
      checkpoints,
      date,
      timezone,
      nowTimestamp,
      reservedIntervals,
    });
    output.push(...materialized.blocks);
    if (materialized.incomplete) deferred.add(task.id);
  }

  assertNoOverlap(output);
  return {
    ...schedule,
    blocks: output.sort(compareBlocks),
    deferred: [...deferred],
  };
}

function materializeTaskCheckpoints({
  task,
  parentBlocks,
  checkpoints,
  date,
  timezone,
  nowTimestamp,
  reservedIntervals,
}) {
  const sortedParents = [...parentBlocks].sort(compareBlocks);
  const output = [];
  let cursor = Math.max(
    new Date(sortedParents[0].startsAt).getTime(),
    nowTimestamp ?? Number.NEGATIVE_INFINITY,
  );
  let incomplete = false;

  for (const [checkpointIndex, checkpoint] of checkpoints.entries()) {
    if (checkpoint.completed) continue;
    if (checkpoint.startsAt && checkpoint.endsAt) {
      const start = new Date(checkpoint.startsAt);
      const end = new Date(checkpoint.endsAt);
      if (!validInterval(start, end)) throw new Error("invalid checkpoint interval");
      if (!intervalFallsOnDate(start, end, date, timezone)) {
        incomplete = true;
        continue;
      }
      const source = sortedParents.find((block) => intervalStartsInBlock(start, block)) || sortedParents[0];
      if (preservesExplicitAnchor({ task, source, start, end, nowTimestamp })) {
        output.push(checkpointBlock(source, checkpointIndex, start, end));
        cursor = Math.max(cursor, end.getTime());
        continue;
      }
    }

    const minutes = checkpointMinutes(checkpoint);
    const slot = Number.isFinite(minutes) && minutes > 0
      ? nextSequentialSlot(sortedParents, cursor, minutes, reservedIntervals)
      : null;
    if (!slot) {
      incomplete = true;
      continue;
    }
    output.push(checkpointBlock(slot.parentBlock, checkpointIndex, slot.start, slot.end));
    cursor = slot.end.getTime();
  }

  return { blocks: output, incomplete };
}

function nextSequentialSlot(parentBlocks, cursor, minutes, occupied = []) {
  const duration = minutes * 60_000;
  for (const parentBlock of parentBlocks) {
    const blockStart = new Date(parentBlock.startsAt).getTime();
    const blockEnd = new Date(parentBlock.endsAt).getTime();
    let start = Math.max(blockStart, cursor);
    for (const interval of occupied) {
      if (interval.end <= start || interval.start >= blockEnd) continue;
      if (start + duration <= interval.start) break;
      start = Math.max(start, interval.end);
    }
    if (start + duration <= blockEnd) {
      return {
        parentBlock,
        start: new Date(start),
        end: new Date(start + duration),
      };
    }
  }
  return null;
}

function collectCurrentAndFutureAnchors({ tasks, selectedTaskIds, parentBlocksByTask, date, timezone, nowTimestamp }) {
  const intervals = [];
  for (const task of tasks || []) {
    if (!selectedTaskIds.has(task.id)) continue;
    for (const checkpoint of task.checkpoints || []) {
      if (checkpoint.completed || !checkpoint.startsAt || !checkpoint.endsAt) continue;
      const start = new Date(checkpoint.startsAt);
      const end = new Date(checkpoint.endsAt);
      if (!validInterval(start, end) || !intervalFallsOnDate(start, end, date, timezone)) continue;
      const parentBlocks = parentBlocksByTask.get(task.id) || [];
      const source = parentBlocks.find((block) => intervalStartsInBlock(start, block)) || parentBlocks[0];
      if (!preservesExplicitAnchor({ task, source, start, end, nowTimestamp })) continue;
      intervals.push({ start: start.getTime(), end: end.getTime() });
    }
  }
  return intervals.sort((left, right) => left.start - right.start || left.end - right.end);
}

function preservesExplicitAnchor({ task, source, start, end, nowTimestamp }) {
  if (nowTimestamp == null || start.getTime() >= nowTimestamp) return true;
  if (end.getTime() <= nowTimestamp) return false;
  return task?.status === "doing" || source?.status === "doing";
}

function checkpointMinutes(checkpoint) {
  const explicitMinutes = Number(checkpoint.minutes);
  if (Number.isFinite(explicitMinutes) && explicitMinutes > 0) return explicitMinutes;
  if (checkpoint.startsAt && checkpoint.endsAt) {
    const duration = (new Date(checkpoint.endsAt) - new Date(checkpoint.startsAt)) / 60_000;
    if (Number.isFinite(duration) && duration > 0) return duration;
  }
  return 15;
}

function optionalTimestamp(value) {
  if (value == null || value === "") return null;
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) throw new Error("valid checkpoint schedule time is required");
  return timestamp;
}

function checkpointBlock(parentBlock, checkpointIndex, start, end) {
  return {
    ...parentBlock,
    checkpointIndex,
    startsAt: start.toISOString(),
    endsAt: end.toISOString(),
  };
}

function groupBlocksByTask(blocks) {
  const grouped = new Map();
  for (const block of blocks) {
    if (!grouped.has(block.taskId)) grouped.set(block.taskId, []);
    grouped.get(block.taskId).push(block);
  }
  return grouped;
}

function intervalStartsInBlock(start, block) {
  const timestamp = start.getTime();
  return timestamp >= new Date(block.startsAt).getTime()
    && timestamp < new Date(block.endsAt).getTime();
}

function intervalFallsOnDate(start, end, date, timezone) {
  return localDate(start, timezone) === date
    && localDate(new Date(end.getTime() - 1), timezone) === date;
}

function localDate(value, timezone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(value).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function validInterval(start, end) {
  return !Number.isNaN(start.getTime())
    && !Number.isNaN(end.getTime())
    && end > start;
}

function assertNoOverlap(blocks) {
  const sorted = [...blocks].sort(compareBlocks);
  for (let index = 1; index < sorted.length; index += 1) {
    if (new Date(sorted[index].startsAt) < new Date(sorted[index - 1].endsAt)) {
      throw new Error("checkpoint schedule overlaps");
    }
  }
}

function compareBlocks(left, right) {
  return left.startsAt.localeCompare(right.startsAt)
    || left.endsAt.localeCompare(right.endsAt)
    || String(left.taskId).localeCompare(String(right.taskId));
}
