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
      date: state.workDate,
      ...(state.now ? { now: state.now } : {}),
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
      date: state.workDate,
      ...(state.now ? { now: state.now } : {}),
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
      if (state.node === "24:00") {
        state.actions.push({
          type: "candidate_recorded",
          title: item.title || "复盘节点收到的任务反馈",
          reason: "task_feedback_rejected_at_review",
        });
        state.replyParts.push("任务范围反馈未应用：24:00 只做复盘，请在次日规划节点重新发送。");
        state.changed = true;
        continue;
      }
      const feedback = await applyTaskFeedback(item, state, deps);
      if (!feedback) {
        state.actions.push({
          type: "candidate_recorded",
          title: item.title || "待确认的任务反馈",
          reason: "unknown_or_invalid_task_feedback",
        });
        state.changed = true;
        continue;
      }
      state.actions.push({ type: "task_feedback", taskId: feedback.task.id, detail: feedback.task.nextAction });
      state.changed = true;
      if (feedback.event.payload.changed === true) {
        state.feedbackReplanKeys ||= [];
        state.feedbackReplanKeys.push(feedback.event.idempotencyKey);
      } else state.schedule ||= readSchedule(state, deps);
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
  const feedbackReplanKeys = [...new Set(state.feedbackReplanKeys || [])].sort();
  if (!state.tasksCreated && !feedbackReplanKeys.length) return;
  if (feedbackReplanKeys.length) {
    state.feedbackReplanKey = `task-feedback-replan:${stableDigest(state.workDate, state.node, feedbackReplanKeys)}`;
  }
  if (state.node === "08:00" || state.node === "24:00") return;
  const options = {
    date: state.workDate,
    reason: `checkpoint_${state.node}`,
    deliveryMode: "task_dm",
    ...(state.now ? { now: state.now } : {}),
  };
  if (state.feedbackReplanKey) options.idempotencyKey = state.feedbackReplanKey;
  if (EVENING_NODES.has(state.node)) options.maxCriticalTasks = 1;
  state.schedule = await deps.manager.replanDay(options);
  state.nodeScheduleFinalized = true;
}

async function runDailyDispatch(state, deps) {
  state.schedule = await deps.manager.dispatchDay({
    date: state.workDate,
    deliveryMode: "task_dm",
    ...(state.now ? { now: state.now } : {}),
    ...(state.feedbackReplanKey ? { idempotencyKey: state.feedbackReplanKey } : {}),
  });
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
  state.schedule ||= await deps.manager.replanDay({ date: state.workDate, ...(state.now ? { now: state.now } : {}), reason: "checkpoint_09:00", deliveryMode: "task_dm" });
}

async function runMorningProgress(state, deps) {
  if (state.changed && !state.schedule) {
    state.schedule = await deps.manager.replanDay({ date: state.workDate, ...(state.now ? { now: state.now } : {}), reason: "checkpoint_12:00", deliveryMode: "task_dm" });
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
  if (!state.nodeScheduleFinalized) {
    state.schedule = await deps.manager.replanDay({ date: state.workDate, ...(state.now ? { now: state.now } : {}), reason: "checkpoint_18:00", deliveryMode: "task_dm", maxCriticalTasks: 1 });
  }
  if (state.schedule.blocks.length || state.changed) {
    state.actions.push({ type: "evening_trim", schedule: state.schedule });
    state.changed = true;
  }
}

async function runFinalSprint(state, deps) {
  if (!state.nodeScheduleFinalized) {
    state.schedule = await deps.manager.replanDay({ date: state.workDate, ...(state.now ? { now: state.now } : {}), reason: "checkpoint_21:00", deliveryMode: "task_dm", maxCriticalTasks: 1 });
  }
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
  if (schedule?.blocks) {
    if (Number.isInteger(schedule.version)) return schedule;
    const version = Math.max(0, ...schedule.blocks.map((block) => Number(block.version) || 0));
    return version > 0 ? { ...schedule, version } : schedule;
  }
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

async function applyTaskFeedback(item, state, deps) {
  if (typeof item?.taskId !== "string" || !item.taskId.trim()
    || typeof deps.tasks?.findById !== "function"
    || typeof deps.manager?.applyTaskFeedback !== "function") return null;
  const current = deps.tasks.findById(item.taskId);
  if (!current || ["done", "cancelled", "pending_acceptance"].includes(current.status)) return null;
  const source = feedbackSource(item, state.messages);
  if (!source || !sourceRequestsFeedbackChange(source.text)
    || !sourceIdentifiesTask(source.text, current, deps.tasks)) return null;
  const patch = feedbackScopePatch(item, current, deps.links);
  if (!patch) return null;
  const result = await deps.manager.applyTaskFeedback({
    taskId: current.id,
    patch,
    messageIds: source.messageIds,
    idempotencyKey: `checkpoint-task-feedback:${stableDigest(current.id, source.messageIds)}`,
  });
  const event = result?.event;
  if (!["updated", "unchanged", "duplicate"].includes(result?.action) || !result.task
    || event?.kind !== "task_feedback_applied"
    || event.taskId !== current.id
    || event.idempotencyKey !== `checkpoint-task-feedback:${stableDigest(current.id, source.messageIds)}`
    || typeof event.payload?.changed !== "boolean"
    || (result.action === "updated" && event.payload.changed !== true)
    || (result.action === "unchanged" && event.payload.changed !== false)) return null;
  return result;
}

function feedbackScopePatch(item, current, links) {
  const nextAction = cleanText(item.nextAction);
  const doneDefinition = cleanText(item.doneDefinition);
  const estimateMinutes = Number(item.estimateMinutes);
  const existing = current.checkpoints || [];
  const completedCount = existing.findIndex((checkpoint) => !checkpoint.completed);
  const prefixLength = completedCount === -1 ? existing.length : completedCount;
  if (existing.slice(prefixLength).some((checkpoint) => checkpoint.completed)) return null;
  const completed = existing.slice(0, prefixLength);
  const remaining = Array.isArray(item.checkpoints) ? item.checkpoints : [];
  if (!isConcreteFeedbackText(nextAction)
    || !isConcreteFeedbackText(doneDefinition)
    || !Number.isInteger(estimateMinutes) || estimateMinutes < 1 || estimateMinutes > 480
    || remaining.length < 1 || completed.length + remaining.length > 8) return null;

  const checkpoints = [];
  let checkpointMinutes = 0;
  for (const checkpoint of remaining) {
    if (!checkpoint || typeof checkpoint !== "object" || Array.isArray(checkpoint)
      || Object.keys(checkpoint).some((field) => !["title", "minutes"].includes(field))) return null;
    const title = cleanText(checkpoint.title);
    const minutes = Number(checkpoint.minutes);
    if (!isConcreteCheckpointTitle(title)
      || !Number.isInteger(minutes) || minutes < 15 || minutes > 45) return null;
    checkpoints.push({ title, minutes, completed: false });
    checkpointMinutes += minutes;
  }
  if (checkpointMinutes !== estimateMinutes) return null;
  const nextLength = completed.length + checkpoints.length;
  if (nextLength < existing.length && typeof links?.listFeishuLinks !== "function") return null;
  if (typeof links?.listFeishuLinks === "function") {
    let taskLinks;
    try {
      taskLinks = links.listFeishuLinks(current.id);
    } catch {
      return null;
    }
    if (!Array.isArray(taskLinks)
      || taskLinks.some((link) => Number.isInteger(link.checkpointIndex)
        && link.checkpointIndex >= nextLength)) return null;
  }
  return {
    nextAction,
    doneDefinition,
    estimateMinutes,
    checkpoints: [...completed, ...checkpoints],
  };
}

function feedbackSource(item, messages) {
  const messageIds = [...new Set(Array.isArray(item?.messageIds) ? item.messageIds : [])]
    .filter((id) => typeof id === "string" && id)
    .sort();
  if (!messageIds.length) return null;
  const byId = new Map((messages || []).map((message) => [message?.messageId, message]));
  if (messageIds.some((id) => !byId.has(id))) return null;
  const texts = messageIds.map((id) => sourceMessageText(byId.get(id))).filter(Boolean);
  if (!texts.length) return null;
  return { messageIds, text: texts.join("\n") };
}

function sourceMessageText(message) {
  if (typeof message?.content?.text === "string") return cleanText(message.content.text);
  if (typeof message?.content === "string") return cleanText(message.content);
  if (typeof message?.text === "string") return cleanText(message.text);
  return "";
}

function sourceRequestsFeedbackChange(value) {
  const text = cleanText(value);
  const directChange = /(?:缩减|缩小|减少|减到|降到|砍掉|删掉|去掉|改成|改为|调整为|只(?:做|拍|录制|完成|保留)|先(?:做|拍|录制|完成))/u;
  return directChange.test(text)
    || /(?:调整到|改到)\s*\d+\s*(?:个|条|份|页|次|张|段|分钟|小时|版|项|家|人)/u.test(text)
    || /(?:来不及|赶不及).{0,30}(?:先|只|缩|减)/u.test(text);
}

function sourceIdentifiesTask(sourceText, target, tasks) {
  const eligible = (typeof tasks?.listActive === "function" ? tasks.listActive() : [target])
    .filter((task) => task && !["done", "cancelled", "pending_acceptance"].includes(task.status));
  if (!eligible.some((task) => task.id === target.id)) return false;
  const normalizedSource = normalizeTaskLanguage(sourceText);
  const scored = eligible
    .map((task) => ({ task, score: feedbackTaskMatchScore(normalizedSource, task) }))
    .filter((entry) => entry.score >= 2)
    .sort((left, right) => right.score - left.score || left.task.id.localeCompare(right.task.id));
  if (scored.length && scored[0].task.id === target.id
    && (scored.length === 1 || scored[0].score > scored[1].score)) return true;
  const doing = eligible.filter((task) => task.status === "doing");
  return doing.length === 1 && doing[0].id === target.id
    && /(?:这个任务|当前任务|正在做的任务|手上这件事)/u.test(sourceText);
}

function feedbackTaskMatchScore(normalizedSource, task) {
  const aliases = taskAliases(task).map(normalizeTaskLanguage).filter((alias) => alias.length >= 3);
  if (aliases.some((alias) => normalizedSource.includes(alias))) return 100;
  const sourceSignals = taskSignals(normalizedSource);
  const taskSignalSet = new Set(aliases.flatMap((alias) => [...taskSignals(alias)]));
  return [...sourceSignals].filter((signal) => taskSignalSet.has(signal)).length;
}

function taskAliases(task) {
  return [task.title, task.rawInput, task.nextAction, ...(task.checkpoints || []).map((checkpoint) => checkpoint.title)]
    .flatMap((value) => cleanText(value).split(/[｜|:：—-]/u))
    .filter(Boolean);
}

function taskSignals(value) {
  const signals = new Set();
  const actions = ["拍", "写", "发", "修复", "验证", "测试", "整理", "记录", "核对", "导出", "发布", "配置", "确认", "提交"];
  for (const action of actions) if (value.includes(action)) signals.add(`action:${action}`);
  for (const quantity of value.match(/\d+(?:个|条|份|页|次|张|段|分钟|小时|版|项|家|人)/gu) || []) {
    signals.add(`quantity:${quantity}`);
  }
  const nouns = ["极享os", "codex", "crm", "个人ip", "口播", "脚本", "视频", "原片", "客户", "线索", "财务", "订单", "提成", "售后", "直播", "文案", "页面", "模块", "需求", "数据", "名单"];
  for (const noun of nouns) if (value.includes(noun)) signals.add(`noun:${noun}`);
  return signals;
}

function normalizeTaskLanguage(value) {
  return cleanText(value)
    .toLocaleLowerCase("zh-CN")
    .replace(/(?:录制|拍摄)/gu, "拍")
    .replace(/[\s，。！？；：、,.!?;:｜|()（）【】\[\]{}《》“”'"—_-]+/gu, "");
}

function isConcreteFeedbackText(value) {
  const text = cleanText(value);
  if (text.length < 4 || /(?:一下|相关内容|所有工作|全部工作|整个项目|项目进度|这个事情|这件事)/u.test(text)) return false;
  return /(?:写出|列出|确定|完成|提交|发布|录制|拍摄|修复|验证|确认|整理|记录|创建|生成|发送|更新|删除|安装|配置|测试|复核|对比|标注|导出|实现|交付|已提交|已发布|已完成)/u.test(text);
}

function isConcreteCheckpointTitle(value) {
  const text = cleanText(value);
  if (!isConcreteFeedbackText(text)) return false;
  const hasBoundedQuantity = /\d+\s*(?:个|条|份|页|次|张|段|分钟|小时|版|项|家|人)/u.test(text);
  const hasObservableResult = /(?:脚本|文案|视频|原片|截图|链接|页面|模块|测试|记录|清单|提纲|开头|结尾|代码|需求|方案|数据|名单|日志|复现步骤|案例|口播)/u.test(text);
  return hasBoundedQuantity || hasObservableResult;
}

function cleanText(value) {
  return typeof value === "string" ? value.replace(/\s+/gu, " ").trim() : "";
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
