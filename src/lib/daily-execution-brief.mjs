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
    `【${headingDate(date)}执行令｜今天只完成${outcomeTasks.length}个结果】`,
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
    if (action) return `【立即开始】\n现在第一步：${action}`;
  }
  return "【立即开始】\n现在第一步：等待下一反馈节点确认计划。";
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

  const lines = [node ? `【${clean(node)}计划调整】` : "【计划调整】"];
  if (cleanFacts.length) lines.push(`事实：${cleanFacts.join("；")}`);
  if (cleanChanges.length) lines.push(`调整：${cleanChanges.join("；")}`);
  if (action) lines.push(`现在只做：${action}`);
  if (clean(feedbackDeadline)) lines.push(`反馈截止：${clean(feedbackDeadline)}`);
  return lines.join("\n");
}

function renderVictoryConditions(tasks) {
  const lines = ["【今日胜利条件】"];
  if (!tasks.length) return [...lines, "暂无可执行结果。"].join("\n");
  tasks.forEach((task, index) => lines.push(`${index + 1}. ${outcomeTitle(task)}`));
  return lines.join("\n");
}

function renderTimeline(blocks, byId, deferred, timezone) {
  const lines = ["【时间安排】"];
  if (!blocks.length) return [...lines, "暂无可执行时间块。"].join("\n");

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
      `工作内容：${action}`,
      `完成标准：${doneDefinition}`,
      ...(clean(checkpoint?.feedback) ? [`反馈：${clean(checkpoint.feedback)}`] : []),
    ].join("\n"));
  }
  return lines.join("\n\n");
}

function renderBreaks() {
  return [
    "【午休与缓冲】",
    "12:00–14:00｜午休，不安排任务",
    "其他未排时间保留为缓冲，只处理必须由本人决策的阻塞。",
  ].join("\n");
}

function renderDoNotDo(items) {
  const values = cleanList(items);
  return [
    "【今天不做】",
    ...(values.length ? values.map((item) => `- ${item}`) : ["- 不临时新增低价值事项"]),
  ].join("\n");
}

function renderFeedback(nodes) {
  const values = cleanList(nodes);
  return [
    "【反馈规则】",
    "完成：在飞书点对应子任务。",
    "卡住：回复“卡住：任务名｜原因”。",
    "推迟：回复“推迟：任务名｜原因｜新的完成时间”。",
    ...(values.length ? [`反馈节点：${values.join("、")}`] : []),
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
