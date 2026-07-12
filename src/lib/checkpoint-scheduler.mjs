export function materializeCheckpointSchedule({ schedule, tasks, date, timezone }) {
  const byId = new Map((tasks || []).map((task) => [task.id, task]));
  const parentBlocksByTask = groupBlocksByTask(schedule.blocks || []);
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
      parentBlocks: parentBlocksByTask.get(task.id),
      checkpoints,
      date,
      timezone,
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

function materializeTaskCheckpoints({ parentBlocks, checkpoints, date, timezone }) {
  const sortedParents = [...parentBlocks].sort(compareBlocks);
  const output = [];
  let cursor = new Date(sortedParents[0].startsAt).getTime();
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
      output.push(checkpointBlock(source, checkpointIndex, start, end));
      cursor = Math.max(cursor, end.getTime());
      continue;
    }

    const minutes = Number(checkpoint.minutes || 15);
    const slot = Number.isFinite(minutes) && minutes > 0
      ? nextSequentialSlot(sortedParents, cursor, minutes)
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

function nextSequentialSlot(parentBlocks, cursor, minutes) {
  const duration = minutes * 60_000;
  for (const parentBlock of parentBlocks) {
    const blockStart = new Date(parentBlock.startsAt).getTime();
    const blockEnd = new Date(parentBlock.endsAt).getTime();
    const start = Math.max(blockStart, cursor);
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
