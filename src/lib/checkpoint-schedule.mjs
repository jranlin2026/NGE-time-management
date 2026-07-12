export const CHECKPOINT_NODES = Object.freeze(["08:00", "09:00", "12:00", "15:00", "18:00", "21:00", "24:00"]);

const DAY_NODES = CHECKPOINT_NODES.filter((node) => node !== "24:00");

export function resolveCheckpointContext({ now = new Date(), timezone = "Asia/Shanghai" } = {}) {
  const instant = new Date(now);
  if (Number.isNaN(instant.getTime())) throw new Error("valid checkpoint time is required");
  const local = localParts(instant, timezone);
  const workDate = `${local.year}-${local.month}-${local.day}`;
  if (local.hour === 0 && local.minute === 0) {
    return { workDate: addLocalDays(workDate, -1), currentNode: "24:00" };
  }
  const minuteOfDay = local.hour * 60 + local.minute;
  const currentNode = [...DAY_NODES]
    .reverse()
    .find((node) => clockMinutes(node) <= minuteOfDay) || null;
  return { workDate, currentNode };
}

export function dueCheckpointNodes({ now = new Date(), timezone = "Asia/Shanghai", completedNodes = [] } = {}) {
  const context = resolveCheckpointContext({ now, timezone });
  if (!context.currentNode) return { ...context, nodes: [] };
  const completed = new Set(completedNodes || []);
  const isComplete = (node, date = context.workDate) => completed.has(node)
    || completed.has(`${date}:${node}`)
    || completed.has(`${date}T${node}`);
  const nodes = [];

  if (context.currentNode !== "24:00") {
    const previousDate = addLocalDays(context.workDate, -1);
    if (!isComplete("24:00", previousDate)) nodes.push("24:00");
  }
  if (context.currentNode !== "24:00" && context.currentNode !== "08:00" && !isComplete("08:00")) {
    nodes.push("08:00");
  }
  if (!isComplete(context.currentNode)) nodes.push(context.currentNode);
  return { ...context, nodes: [...new Set(nodes)] };
}

function clockMinutes(node) {
  const [hour, minute] = node.split(":").map(Number);
  return hour * 60 + minute;
}

function localParts(date, timezone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(date).map((part) => [part.type, part.value]));
  return { year: parts.year, month: parts.month, day: parts.day, hour: Number(parts.hour), minute: Number(parts.minute) };
}

function addLocalDays(date, amount) {
  const [year, month, day] = date.split("-").map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day + amount));
  return shifted.toISOString().slice(0, 10);
}
