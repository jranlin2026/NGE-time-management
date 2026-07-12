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
    async apply(input) {
      const handler = handlers[input?.node];
      if (!handler) throw new Error(`unsupported checkpoint node: ${input?.node}`);
      const state = {
        ...input,
        messages: input.messages || [],
        analysis: input.analysis || { items: [] },
        remoteProgress: input.remoteProgress || {},
        actions: [],
        replyParts: [],
        changed: false,
        schedule: null,
      };

      await applyRemoteProgress(state, deps);
      await applyDeterministicItems(state, deps);
      await createActionableTasks(state, deps);
      await replanCreatedTasks(state, deps);
      await handler(state, deps);
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

async function applyRemoteProgress(state, deps) {
  for (const change of state.remoteProgress.completedCheckpoints || []) {
    const task = deps.tasks.findById?.(change.localTaskId);
    if (task?.checkpoints?.[change.checkpointIndex]?.completed) continue;
    await deps.manager.handleAction({
      action: "complete_checkpoint",
      taskId: change.localTaskId,
      checkpointIndex: change.checkpointIndex,
      idempotencyKey: `feishu-checkpoint:${change.taskGuid}:${change.completedAt}`,
      deliveryMode: "task_dm",
      suppressOutbox: true,
    });
    state.actions.push({ type: "checkpoint_completed", taskId: change.localTaskId, checkpointIndex: change.checkpointIndex });
    state.replyParts.push(`已同步完成关卡：${task?.checkpoints?.[change.checkpointIndex]?.title || change.localTaskId}`);
    state.changed = true;
  }
  for (const change of state.remoteProgress.completedParents || []) {
    const result = await deps.manager.handleAction({
      action: "complete",
      taskId: change.localTaskId,
      idempotencyKey: `feishu-parent:${change.taskGuid}:${change.completedAt}`,
      deliveryMode: "task_dm",
      suppressOutbox: true,
    });
    state.actions.push({ type: "parent_completed", taskId: change.localTaskId });
    state.replyParts.push(result?.action === "evidence_required"
      ? `已同步主任务完成：${change.localTaskId}。请补充验收证据。`
      : `已同步主任务完成：${change.localTaskId}`);
    state.changed = true;
  }
}

async function applyDeterministicItems(state, deps) {
  for (const item of state.analysis.items || []) {
    if (item.disposition === "evidence_submission" && deps.manager.submitEvidence && item.taskId) {
      await deps.manager.submitEvidence({ taskId: item.taskId, evidence: item.evidence || item.title, messageIds: item.messageIds });
      state.actions.push({ type: "evidence_submitted", taskId: item.taskId });
      state.changed = true;
    } else if (item.disposition === "task_feedback") {
      state.actions.push({ type: "task_feedback", taskId: item.taskId || null, detail: item.nextAction || item.title });
      state.changed = true;
    } else if (item.disposition === "candidate_pool") {
      state.actions.push({ type: "candidate_recorded", title: item.title });
      state.replyParts.push(`已进入候选池：${item.title}`);
      state.changed = true;
    } else if (item.disposition === "do_not_schedule") {
      state.actions.push({ type: "not_scheduled", title: item.title, rationale: item.rationale });
      state.replyParts.push(`暂不安排：${item.title}。${item.rationale || "当前不占用核心执行时间。"}`);
      state.changed = true;
    }
  }
}

async function createActionableTasks(state, deps) {
  for (const item of state.analysis.items || []) {
    if (!ACTIONABLE_DISPOSITIONS.has(item.disposition)) continue;
    if (item.disposition === "interrupt_now" && item.groundedP0 !== true) {
      state.actions.push({ type: "candidate_recorded", title: item.title, reason: "ungrounded_interrupt" });
      state.replyParts.push(`已进入候选池：${item.title}`);
      state.changed = true;
      continue;
    }
    const created = await deps.tasks.create(taskInput(item));
    state.actions.push({ type: "task_created", disposition: item.disposition, taskId: created.id });
    const doing = deps.tasks.findDoing?.();
    if (item.disposition === "interrupt_now" && doing && doing.id !== created.id) {
      state.actions.push({ type: "interrupt_current", taskId: created.id });
    }
    state.replyParts.push(`${item.disposition === "interrupt_now" ? "已立即插入" : "已安排到今天"}：${created.title}`);
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
  state.replyParts.push(renderDispatch(state.schedule, deps.tasks.listActive()));
  state.changed = true;
}

async function runMorningCalibration(state, deps) {
  if (!state.changed) return;
  state.schedule ||= await deps.manager.replanDay({ date: state.workDate, reason: "checkpoint_09:00", deliveryMode: "task_dm" });
  state.replyParts.push("上午计划已合并调整。请按飞书任务中的最新顺序执行。");
}

async function runMorningProgress(state, deps) {
  const active = activeForProgress(deps.tasks.listActive());
  if (hasProgress(active, state.remoteProgress)) {
    if (state.changed) state.replyParts.push("上午进度已同步，14:00 继续下一项。");
    return;
  }
  const checkpoint = firstIncompleteCheckpoint(active);
  if (!checkpoint) return;
  state.actions.push({ type: "minimum_action", minutes: 15, title: checkpoint.title });
  state.replyParts.push(`上午还没有可见进度。现在只做一个15分钟动作：${checkpoint.title}。`);
  state.changed = true;
}

async function runAfternoonStartCheck(state, deps) {
  const active = activeForProgress(deps.tasks.listActive());
  const doing = deps.tasks.findDoing?.() || active.find((task) => task.status === "doing");
  if (doing || hasProgress(active, state.remoteProgress)) return;
  const checkpoint = firstIncompleteCheckpoint(active);
  if (!checkpoint) return;
  state.actions.push({ type: "minimum_action", minutes: 15, title: checkpoint.title });
  state.replyParts.push(`下午尚未启动。现在开始15分钟：${checkpoint.title}，完成后直接提交结果。`);
  state.changed = true;
}

async function runDayOutcomeCheck(state, deps) {
  state.schedule ||= await deps.manager.replanDay({ date: state.workDate, reason: "checkpoint_18:00", deliveryMode: "task_dm", maxCriticalTasks: 1 });
  state.schedule = keepOneCoreTask(state.schedule);
  if (state.schedule.blocks.length || state.changed) {
    state.replyParts.push("晚间只保留一个最接近交付的核心任务，其余不顺延堆积。");
    state.changed = true;
  }
}

async function runFinalSprint(state, deps) {
  state.schedule ||= await deps.manager.replanDay({ date: state.workDate, reason: "checkpoint_21:00", deliveryMode: "task_dm", maxCriticalTasks: 1 });
  state.schedule = keepOneCoreTask(state.schedule);
  const active = activeForProgress(deps.tasks.listActive());
  const doing = deps.tasks.findDoing?.() || active.find((task) => task.status === "doing");
  if (doing) state.replyParts.push(`晚间任务保持不变：${doing.title}，最晚 24:00 提交。`);
  else {
    const checkpoint = firstIncompleteCheckpoint(active);
    if (checkpoint) {
      state.actions.push({ type: "minimum_action", minutes: 15, title: checkpoint.title });
      state.replyParts.push(`今晚只启动一个15分钟动作：${checkpoint.title}，不再加入大任务。`);
    }
  }
  if (state.schedule.blocks.length || state.replyParts.length) state.changed = true;
}

async function runDailyReview(state, deps) {
  const review = deps.reviewDay ? await deps.reviewDay({ date: state.workDate }) : null;
  state.actions.push({ type: "daily_review", date: state.workDate });
  state.replyParts.push(review?.renderedText || review?.text || "今日复盘已生成。");
  state.changed = true;
}

function taskInput(item) {
  return {
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

function sumCheckpointMinutes(checkpoints = []) {
  return checkpoints.reduce((sum, checkpoint) => sum + Number(checkpoint.minutes || 0), 0);
}

function activeForProgress(tasks) {
  return (tasks || []).filter((task) => ["scheduled", "doing", "blocked", "pending_acceptance"].includes(task.status));
}

function hasProgress(tasks, remoteProgress) {
  return (remoteProgress.completedParents || []).length > 0
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

function keepOneCoreTask(schedule) {
  if (!schedule) return { blocks: [] };
  const firstTaskId = schedule.blocks?.[0]?.taskId;
  return { ...schedule, blocks: firstTaskId ? schedule.blocks.filter((block) => block.taskId === firstTaskId) : [] };
}

function renderDispatch(schedule, tasks) {
  const firstBlock = schedule?.blocks?.[0];
  const first = tasks.find((task) => task.id === firstBlock?.taskId);
  return [
    `今日必胜：${first?.title || "按周计划推进核心交付"}`,
    `任务数量：${new Set((schedule?.blocks || []).map((block) => block.taskId)).size}`,
    `第一步：${first?.checkpoints?.find((item) => !item.completed)?.title || first?.nextAction || "打开飞书任务开始执行"}`,
    "临时输入将在固定节点统一处理。",
  ].join("\n");
}

export { EVENING_NODES };
