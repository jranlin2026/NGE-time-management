import { createHash } from "node:crypto";
import { renderDailyExecutionBrief, renderPlanDelta } from "./daily-execution-brief.mjs";

const ACTIONABLE_DISPOSITIONS = new Set(["interrupt_now", "schedule_today"]);
const EVENING_NODES = new Set(["18:00", "21:00"]);

export function createCheckpointPolicy(deps) {
  if (!deps?.manager || !deps?.tasks) throw new Error("checkpoint policy requires manager and tasks");
  const handlers = {
    "08:00": runDailyDispatch,
    "09:00": runMorningCalibration,
    "12:00": runMorningProgress,
    "15:00": runAfternoonStartCheck,
    "18:00": runDayOutcomeCheck,
    "21:00": runFinalSprint,
    "24:00": runDailyReview,
  };

  return {
    async reconcileRemoteProgress(input) {
      const state = createState(input);
      state.previousSchedule = readSchedule(state, deps);
      await applyRemoteProgress(state, deps);
      return {
        actions: state.actions,
        replyParts: state.replyParts,
        changed: state.changed,
        schedule: state.schedule,
        previousSchedule: state.previousSchedule,
      };
    },
    async apply(input) {
      const handler = handlers[input?.node];
      if (!handler) throw new Error(`unsupported checkpoint node: ${input?.node}`);
      const state = createState(input);
      state.previousSchedule ||= readSchedule(state, deps);

      if (!input.remoteProgressApplied) await applyRemoteProgress(state, deps);
      await applyDeterministicItems(state, deps);
      await createActionableTasks(state, deps);
      await replanCreatedTasks(state, deps);
      await handler(state, deps);
      if (state.node !== "08:00" && state.node !== "24:00") finalizeCheckpointReply(state, deps);
      const reply = state.replyParts.filter(Boolean).join("\n");
      return {
        node: state.node,
        workDate: state.workDate,
        changed: state.changed,
        replyRequired: Boolean(reply),
        reply,
        actions: state.actions,
        schedule: state.schedule,
      };
    },
  };
}

function createState(input) {
  return {
    ...input,
    messages: input.messages || [],
    analysis: input.analysis || { items: [] },
    remoteProgress: input.remoteProgress || {},
    actions: [...(input.prelude?.actions || [])],
    replyParts: [...(input.prelude?.replyParts || [])],
    changed: Boolean(input.prelude?.changed),
    schedule: input.prelude?.schedule || null,
    previousSchedule: input.prelude?.previousSchedule || null,
  };
}

async function applyRemoteProgress(state, deps) {
  for (const change of state.remoteProgress.completedCheckpoints || []) {
    const task = deps.tasks.findById?.(change.localTaskId);
    if (task?.checkpoints?.[change.checkpointIndex]?.completed) continue;
    const result = await deps.manager.handleAction({
      action: "complete_checkpoint",
      taskId: change.localTaskId,
      checkpointIndex: change.checkpointIndex,
      idempotencyKey: `feishu-checkpoint:${change.taskGuid || `${change.localTaskId}:${change.checkpointIndex}`}:${change.completedAt}`,
      deliveryMode: "task_dm",
      suppressOutbox: true,
    });
    state.schedule = result?.schedule || state.schedule;
    state.actions.push({ type: "checkpoint_completed", taskId: change.localTaskId, checkpointIndex: change.checkpointIndex });
    state.changed = true;
  }
  for (const change of state.remoteProgress.completedTasks || []) {
    const result = await deps.manager.handleAction({
      action: "complete",
      taskId: change.localTaskId,
      idempotencyKey: `feishu-parent:${change.taskGuid || change.localTaskId}:${change.completedAt}`,
      deliveryMode: "task_dm",
      suppressOutbox: true,
    });
    state.schedule = result?.schedule || state.schedule;
    state.actions.push({ type: "parent_completed", taskId: change.localTaskId });
    if (result?.action === "evidence_required") state.actions.push({ type: "evidence_required", taskId: change.localTaskId });
    state.changed = true;
  }
}

async function applyDeterministicItems(state, deps) {
  for (const item of state.analysis.items || []) {
    if (item.disposition === "evidence_submission" && deps.manager.submitEvidence) {
      const pending = deps.manager.listPendingAcceptance?.() || [];
      const taskId = item.taskId || (pending.length === 1 ? pending[0].id : null);
      if (!taskId) continue;
      await deps.manager.submitEvidence({
        taskId,
        evidence: evidenceValues(item.evidence, state.messages),
        messageIds: item.evidence?.messageIds || item.messageIds,
        idempotencyKey: `checkpoint-evidence:${stableDigest(item.evidence?.messageIds || item.messageIds || [])}`,
      });
      state.actions.push({ type: "evidence_submitted", taskId });
      state.changed = true;
    } else if (item.disposition === "task_feedback") {
      state.actions.push({ type: "task_feedback", taskId: item.taskId || null, detail: item.nextAction || item.title });
      state.changed = true;
    } else if (item.disposition === "candidate_pool") {
      state.actions.push({ type: "candidate_recorded", title: item.title });
      state.changed = true;
    } else if (item.disposition === "do_not_schedule") {
      state.actions.push({ type: "not_scheduled", title: item.title, rationale: item.rationale });
      state.changed = true;
    }
  }
}

async function createActionableTasks(state, deps) {
  for (const [itemIndex, item] of (state.analysis.items || []).entries()) {
    if (!ACTIONABLE_DISPOSITIONS.has(item.disposition)) continue;
    if (item.disposition === "interrupt_now" && item.groundedP0 !== true) {
      state.actions.push({ type: "candidate_recorded", title: item.title, reason: "ungrounded_interrupt" });
      state.changed = true;
      continue;
    }
    const created = await deps.tasks.create(taskInput(item, itemIndex));
    state.actions.push({ type: "task_created", disposition: item.disposition, taskId: created.id });
    const doing = deps.tasks.findDoing?.();
    if (item.disposition === "interrupt_now" && doing && doing.id !== created.id) {
      state.actions.push({ type: "interrupt_current", taskId: created.id });
    }
    state.changed = true;
    state.tasksCreated = true;
  }
}

async function replanCreatedTasks(state, deps) {
  if (!state.tasksCreated || state.node === "08:00" || state.node === "24:00") return;
  const options = {
    date: state.workDate,
    reason: `checkpoint_${state.node}`,
    deliveryMode: "task_dm",
  };
  if (EVENING_NODES.has(state.node)) options.maxCriticalTasks = 1;
  state.schedule = await deps.manager.replanDay(options);
}

async function runDailyDispatch(state, deps) {
  state.schedule = await deps.manager.dispatchDay({ date: state.workDate, deliveryMode: "task_dm" });
  state.replyParts.push(renderDailyExecutionBrief({
    date: state.workDate,
    schedule: state.schedule,
    tasks: deps.tasks.listActive(),
    timezone: deps.timezone || "Asia/Shanghai",
    feedbackNodes: ["12:00", "15:00", "18:00", "21:00", "24:00"],
    doNotDo: ["不新增项目", "不反复修改已经可交付的版本"],
  }));
  state.changed = true;
}

async function runMorningCalibration(state, deps) {
  if (!state.changed) return;
  state.schedule ||= await deps.manager.replanDay({ date: state.workDate, reason: "checkpoint_09:00", deliveryMode: "task_dm" });
}

async function runMorningProgress(state, deps) {
  if (state.changed && !state.schedule) {
    state.schedule = await deps.manager.replanDay({ date: state.workDate, reason: "checkpoint_12:00", deliveryMode: "task_dm" });
  }
  const active = activeForProgress(deps.tasks.listActive());
  if (hasProgress(active, state.remoteProgress)) {
    return;
  }
  const checkpoint = firstIncompleteCheckpoint(active);
  if (!checkpoint) return;
  state.actions.push({ type: "minimum_action", minutes: 15, title: checkpoint.title });
  state.changed = true;
}

async function runAfternoonStartCheck(state, deps) {
  const active = activeForProgress(deps.tasks.listActive());
  const doing = deps.tasks.findDoing?.() || active.find((task) => task.status === "doing");
  if (doing || hasProgress(active, state.remoteProgress)) return;
  const checkpoint = firstIncompleteCheckpoint(active);
  if (!checkpoint) return;
  state.actions.push({ type: "minimum_action", minutes: 15, title: checkpoint.title });
  state.changed = true;
}

async function runDayOutcomeCheck(state, deps) {
  state.schedule = await deps.manager.replanDay({ date: state.workDate, reason: "checkpoint_18:00", deliveryMode: "task_dm", maxCriticalTasks: 1 });
  if (state.schedule.blocks.length || state.changed) {
    state.actions.push({ type: "evening_trim", schedule: state.schedule });
    state.changed = true;
  }
}

async function runFinalSprint(state, deps) {
  state.schedule = await deps.manager.replanDay({ date: state.workDate, reason: "checkpoint_21:00", deliveryMode: "task_dm", maxCriticalTasks: 1 });
  const active = activeForProgress(deps.tasks.listActive());
  const doing = deps.tasks.findDoing?.() || active.find((task) => task.status === "doing");
  if (doing) {
    state.actions.push({ type: "final_sprint", taskId: doing.id });
  } else {
    const checkpoint = firstIncompleteCheckpoint(active);
    if (checkpoint) {
      state.actions.push({ type: "minimum_action", minutes: 15, title: checkpoint.title });
    }
  }
  if (state.schedule.blocks.length || state.actions.length) state.changed = true;
}

async function runDailyReview(state, deps) {
  const review = deps.reviewDay ? await deps.reviewDay({ date: state.workDate }) : null;
  state.actions.push({ type: "daily_review", date: state.workDate });
  state.replyParts.push(review?.renderedText || review?.text || "今日复盘已生成。");
  state.changed = true;
}

function finalizeCheckpointReply(state, deps) {
  state.schedule ||= readSchedule(state, deps);
  const facts = actionFacts(state.actions, deps.tasks);
  const changes = diffSchedule(state.previousSchedule, state.schedule, deps.tasks, deps.timezone || "Asia/Shanghai");
  if (!facts.length && !changes.length) {
    state.replyParts = [];
    state.changed = false;
    return;
  }
  const explicitChanges = changes.length ? changes : ["排程保持不变"];
  state.replyParts = [renderPlanDelta({
    node: state.node,
    facts,
    changes: explicitChanges,
    currentAction: nextActionAtOrAfter(state.schedule, deps.tasks, state.node, deps.timezone || "Asia/Shanghai")
      || "按当前计划继续执行",
    feedbackDeadline: nextFeedbackNode(state.node),
  })];
  state.changed = true;
}

function readSchedule(state, deps) {
  const schedule = deps.getSchedule?.(state.workDate);
  if (schedule?.blocks) return schedule;
  return { date: state.workDate, blocks: [] };
}

function actionFacts(actions, tasks) {
  const facts = [];
  for (const action of actions || []) {
    const title = action.taskId ? taskTitle(tasks, action.taskId) : "";
    if (action.type === "checkpoint_completed") {
      const task = tasks.findById?.(action.taskId);
      const checkpoint = task?.checkpoints?.[action.checkpointIndex]?.title;
      facts.push(`已同步完成关卡：${checkpoint || title}`);
    } else if (action.type === "parent_completed") facts.push(`已同步主任务完成：${title}`);
    else if (action.type === "evidence_required") facts.push("请补充验收证据");
    else if (action.type === "task_feedback") facts.push(action.detail || "已收到进度反馈");
    else if (action.type === "candidate_recorded") facts.push(`已进入候选池：${action.title}`);
    else if (action.type === "not_scheduled") facts.push(`暂不安排：${action.title}。${action.rationale || "当前不占用核心执行时间。"}`);
    else if (action.type === "task_created") facts.push(`${action.disposition === "interrupt_now" ? "已立即插入" : "已安排到今天"}：${title}`);
    else if (action.type === "minimum_action") facts.push(`尚无可见进度，启动${action.minutes || 15}分钟动作：${action.title}`);
    else if (action.type === "final_sprint") facts.push(`未完成关键交付：${title}`);
    else if (action.type === "evening_trim") {
      const keptId = action.schedule?.blocks?.[0]?.taskId;
      if (keptId) facts.push(`保留晚间工作：${taskTitle(tasks, keptId)}`);
    }
  }
  return facts.filter(Boolean);
}

function diffSchedule(previousSchedule, schedule, tasks, timezone) {
  const previous = new Map((previousSchedule?.blocks || []).map((block) => [scheduleIdentity(block), block]));
  const current = new Map((schedule?.blocks || []).map((block) => [scheduleIdentity(block), block]));
  const changes = [];
  for (const [identity, block] of previous) {
    const next = current.get(identity);
    if (!next) {
      changes.push({ at: block.startsAt || "", text: `移除：${blockTitle(block, tasks)} ${formatInterval(block, timezone)}` });
    } else if (block.startsAt !== next.startsAt || block.endsAt !== next.endsAt) {
      changes.push({ at: next.startsAt || block.startsAt || "", text: `移动：${blockTitle(next, tasks)} ${formatInterval(block, timezone)}→${formatInterval(next, timezone)}` });
    }
  }
  for (const [identity, block] of current) {
    if (!previous.has(identity)) changes.push({ at: block.startsAt || "", text: `新增：${blockTitle(block, tasks)} ${formatInterval(block, timezone)}` });
  }
  return changes
    .sort((left, right) => left.at.localeCompare(right.at) || left.text.localeCompare(right.text))
    .map((item) => item.text);
}

function nextActionAtOrAfter(schedule, tasks, node, timezone) {
  const blocks = [...(schedule?.blocks || [])].sort((left, right) => String(left.startsAt || "").localeCompare(String(right.startsAt || "")));
  const block = blocks.find((item) => {
    const end = localBlockEnd(item, timezone);
    return !end || end > node;
  });
  if (!block) return "";
  const task = tasks.findById?.(block.taskId) || tasks.listActive?.().find((item) => item.id === block.taskId);
  return task?.checkpoints?.[block.checkpointIndex]?.title || task?.nextAction || task?.title || block.taskId;
}

function nextFeedbackNode(node) {
  return ({ "09:00": "12:00", "12:00": "15:00", "15:00": "18:00", "18:00": "21:00", "21:00": "24:00" })[node] || "";
}

function scheduleIdentity(block) {
  return `${block.taskId}:${Number.isInteger(block.checkpointIndex) ? block.checkpointIndex : ""}`;
}

function blockTitle(block, tasks) {
  const task = tasks.findById?.(block.taskId) || tasks.listActive?.().find((item) => item.id === block.taskId);
  const checkpoint = task?.checkpoints?.[block.checkpointIndex]?.title;
  return checkpoint ? `${task.title}｜${checkpoint}` : task?.title || block.taskId;
}

function taskTitle(tasks, taskId) {
  return tasks.findById?.(taskId)?.title || tasks.listActive?.().find((item) => item.id === taskId)?.title || taskId || "未知任务";
}

function formatInterval(block, timezone) {
  const start = localClock(block.startsAt, timezone);
  const end = localBlockEnd(block, timezone);
  return start && end ? `${start}–${end}` : "未定时间";
}

function localBlockEnd(block, timezone) {
  const start = localDateTimeParts(block.startsAt, timezone);
  const end = localDateTimeParts(block.endsAt, timezone);
  if (!start || !end) return "";
  if (end.hour === "00" && end.minute === "00" && localDateKey(start) !== localDateKey(end)) return "24:00";
  return `${end.hour}:${end.minute}`;
}

function localClock(value, timezone) {
  const parts = localDateTimeParts(value, timezone);
  return parts ? `${parts.hour}:${parts.minute}` : "";
}

function localDateTimeParts(value, timezone) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date).map((part) => [part.type, part.value]));
}

function localDateKey(parts) {
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function taskInput(item, itemIndex) {
  return {
    id: `checkpoint-${stableDigest([...(item.messageIds || [])].sort(), item.disposition, itemIndex)}`,
    rawInput: item.title,
    title: item.title,
    project: item.projectId || "未归类",
    projectId: item.projectId || null,
    urgency: item.urgency || "medium",
    dueAt: item.dueAt || null,
    estimateMinutes: Number(item.estimateMinutes || sumCheckpointMinutes(item.checkpoints) || 30),
    nextAction: item.nextAction || item.checkpoints?.[0]?.title || "先做 15 分钟",
    doneDefinition: item.doneDefinition || "提交明确产出",
    status: "ready",
    analysisStatus: "complete",
    checkpoints: (item.checkpoints || []).map((checkpoint) => ({
      title: checkpoint.title,
      minutes: Number(checkpoint.minutes),
      completed: false,
    })),
  };
}

function stableDigest(...parts) {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 32);
}

function evidenceValues(evidence, messages) {
  const byId = new Map((messages || []).map((message) => [message.messageId, message]));
  const referencedIds = evidence?.messageIds || [];
  const sourceTexts = referencedIds
    .map((id) => byId.get(id)?.content?.text)
    .filter((text) => typeof text === "string")
    .map(normalizeEvidenceText)
    .filter(Boolean);
  const sourceText = sourceTexts.join("\n");
  const sourceReferences = referencedIds.flatMap((id) => {
    const content = byId.get(id)?.content || {};
    if (content.imageKey) return [{ type: "feishu_image", value: content.imageKey }];
    if (content.fileKey) return [{ type: "feishu_file", value: content.fileKey }];
    return [];
  });
  return [
    ...(sourceText ? [{ type: "text", value: sourceText }] : []),
    ...extractSourceLinks(sourceText).map((value) => ({ type: "url", value })),
    ...sourceReferences,
  ];
}

function normalizeEvidenceText(text) {
  return String(text).trim().replace(/\s+/gu, " ");
}

function extractSourceLinks(text) {
  const candidates = String(text).match(/https?:\/\/[^\s<>()\[\]{}"']+/gu) || [];
  return [...new Set(candidates
    .map((value) => value.replace(/[.,!?;:，。！？；：]+$/gu, ""))
    .filter((value) => {
      try { new URL(value); return true; } catch { return false; }
    }))];
}

function sumCheckpointMinutes(checkpoints = []) {
  return checkpoints.reduce((sum, checkpoint) => sum + Number(checkpoint.minutes || 0), 0);
}

function activeForProgress(tasks) {
  return (tasks || []).filter((task) => ["scheduled", "doing", "blocked", "pending_acceptance"].includes(task.status));
}

function hasProgress(tasks, remoteProgress) {
  return (remoteProgress.completedTasks || []).length > 0
    || (remoteProgress.completedCheckpoints || []).length > 0
    || tasks.some((task) => task.status === "pending_acceptance" || task.checkpoints?.some((checkpoint) => checkpoint.completed));
}

function firstIncompleteCheckpoint(tasks) {
  for (const task of tasks) {
    const checkpoint = task.checkpoints?.find((item) => !item.completed);
    if (checkpoint) return checkpoint;
    if (task.nextAction) return { title: task.nextAction };
  }
  return null;
}

export { EVENING_NODES };
