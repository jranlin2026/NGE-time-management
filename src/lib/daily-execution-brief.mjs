const DEFAULT_TIMEZONE = "Asia/Shanghai";

export function renderDailyExecutionBrief({
  date,
  schedule,
  tasks,
  timezone = DEFAULT_TIMEZONE,
  feedbackNodes = [],
  doNotDo = [],
} = {}) {
  const byId = new Map((tasks || []).map((task) => [task.id, task]));
  const deferred = new Set(schedule?.deferred || []);
  const blocks = [...(schedule?.blocks || [])]
    .filter((block) => byId.has(block.taskId))
    .sort(compareBlocks);
  const scheduledTaskIds = unique(blocks.map((block) => block.taskId));
  const outcomeTasks = scheduledTaskIds
    .filter((taskId) => !deferred.has(taskId))
    .map((taskId) => byId.get(taskId));

  return [
    `【${headingDate(date)}，今天只盯${outcomeTasks.length}个结果】`,
    renderVictoryConditions(outcomeTasks),
    renderImmediateStart(blocks, byId),
    renderTimeline(blocks, byId, deferred, timezone),
    renderBreaks(),
    renderDoNotDo(doNotDo),
    renderFeedback(feedbackNodes),
  ].join("\n\n");
}

function renderImmediateStart(blocks, byId) {
  for (const block of blocks) {
    const task = byId.get(block.taskId);
    const checkpoint = checkpointFor(task, block.checkpointIndex);
    if (checkpoint?.completed) continue;
    const action = clean(checkpoint?.title) || clean(task?.nextAction);
    if (action) return `先从这一步开始：${action}`;
  }
  return "先别急着加新任务，等我在下一次节点把计划定下来。";
}

export function renderPlanDelta({
  node,
  facts = [],
  changes = [],
  currentAction,
  feedbackDeadline,
} = {}) {
  const cleanFacts = cleanList(facts);
  const cleanChanges = cleanList(changes);
  const action = clean(currentAction);
  if (!cleanFacts.length && !cleanChanges.length && !action) return "";

  const lines = [node ? `【${clean(node)}，我帮你把后面顺了一下】` : "【我帮你把后面顺了一下】"];
  if (cleanFacts.length) lines.push(cleanFacts.join("；"));
  if (cleanChanges.length) lines.push(`后面改成：${cleanChanges.join("；")}`);
  if (action) lines.push(`现在先做：${action}`);
  if (clean(feedbackDeadline)) lines.push(`做到这一步，${clean(feedbackDeadline)}前告诉我结果就行。`);
  return lines.join("\n");
}

function renderVictoryConditions(tasks) {
  const lines = ["今天拿下这几件就够了："];
  if (!tasks.length) return [...lines, "今天先不排任务，等我确认优先级。"].join("\n");
  tasks.forEach((task, index) => lines.push(`${index + 1}. ${outcomeTitle(task)}`));
  return lines.join("\n");
}

function renderTimeline(blocks, byId, deferred, timezone) {
  const lines = ["今天按这个节奏走："];
  if (!blocks.length) return [...lines, "暂时没有需要你亲自处理的时间块。"].join("\n");

  for (const block of blocks) {
    const task = byId.get(block.taskId);
    const checkpoint = checkpointFor(task, block.checkpointIndex);
    const action = clean(checkpoint?.title) || clean(task.nextAction) || clean(task.title);
    const doneDefinition = clean(checkpoint?.doneDefinition)
      || clean(task.doneDefinition)
      || action;
    const partial = deferred.has(block.taskId) ? "（部分进度，等待重排）" : "";
    lines.push([
      `${localTime(block.startsAt, timezone)}–${localEndTime(block, timezone)}｜${action}${partial}`,
      `做到：${doneDefinition}`,
      ...(clean(checkpoint?.feedback) ? [`做完告诉我：${clean(checkpoint.feedback)}`] : []),
    ].join("\n"));
  }
  return lines.join("\n\n");
}

function renderBreaks() {
  return [
    "12:00–14:00先休息，其他空档留给突发情况；只有必须你拍板的事才插进来。",
  ].join("\n");
}

function renderDoNotDo(items) {
  const values = cleanList(items);
  return [
    "今天先别碰：",
    ...(values.length ? values.map((item) => `- ${item}`) : ["- 临时冒出来、但不影响结果的事"]),
  ].join("\n");
}

function renderFeedback(nodes) {
  const values = cleanList(nodes);
  return [
    "做完就点飞书里的子任务；卡住了直接回我卡在哪。",
    "需要推迟就说原因和你准备什么时候补上。",
    ...(values.length ? [`我会在 ${values.join("、")} 主动找你对一次进度。`] : []),
  ].join("\n");
}

function outcomeTitle(task) {
  const project = clean(task?.project);
  const title = clean(task?.title);
  if (!project || !title || title === project) return title || project;
  if (["｜", "|", "：", ":"].some((separator) => title.startsWith(`${project}${separator}`))) {
    return title;
  }
  return `${project}｜${title}`;
}

function checkpointFor(task, checkpointIndex) {
  if (!Number.isInteger(checkpointIndex) || checkpointIndex < 0) return null;
  return task?.checkpoints?.[checkpointIndex] || null;
}

function headingDate(date) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date || ""));
  if (!match) return clean(date);
  return `${Number(match[2])}月${Number(match[3])}日`;
}

function localTime(value, timezone) {
  const parts = localParts(value, timezone);
  return `${parts.hour}:${parts.minute}`;
}

function localEndTime(block, timezone) {
  const start = localParts(block.startsAt, timezone);
  const end = localParts(block.endsAt, timezone);
  if (end.hour === "00" && end.minute === "00" && localDateKey(start) !== localDateKey(end)) {
    return "24:00";
  }
  return `${end.hour}:${end.minute}`;
}

function localParts(value, timezone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(value)).map((part) => [part.type, part.value]));
  return parts;
}

function localDateKey(parts) {
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function compareBlocks(left, right) {
  return String(left.startsAt).localeCompare(String(right.startsAt))
    || String(left.endsAt).localeCompare(String(right.endsAt))
    || String(left.taskId).localeCompare(String(right.taskId));
}

function cleanList(values) {
  return (values || []).map(clean).filter(Boolean);
}

function clean(value) {
  return typeof value === "string" ? value.trim() : "";
}

function unique(values) {
  return [...new Set(values)];
}
