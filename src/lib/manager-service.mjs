import { buildDailySchedule } from "./schedule-engine.mjs";
import { transitionTask } from "./task-state-machine.mjs";
import { renderDailyPlanCard } from "./feishu-cards.mjs";

export function createManagerService(deps) {
  const {
    tasks,
    ops,
    analyzer,
    reminderEngine,
    settings,
  } = deps;
  const transaction = deps.transaction || ((fn) => fn());
  const nowDate = () => deps.clock?.now?.() || new Date();

  async function ingest({ messageId, text, chatId = "", senderId = "" }) {
    if (settings.managerUserId && senderId && senderId !== settings.managerUserId) {
      return { ignored: true, reason: "different_user" };
    }
    const existing = tasks.findBySourceMessageId(messageId);
    if (existing) return existing;

    const task = transaction(() => {
      const created = tasks.create({ rawInput: text, sourceMessageId: messageId });
      ops.appendEvent({
        taskId: created.id,
        kind: "task_created",
        payload: { rawInput: text, chatId, senderId },
        idempotencyKey: `message:${messageId}`,
      });
      ops.enqueueOutbox({
        kind: "task_ack",
        payload: { taskId: created.id, title: created.title, text: "任务已收到，正在判断优先级。" },
        idempotencyKey: `ack:${messageId}`,
      });
      return created;
    });

    const analysis = await analyzer.analyzeTask({
      rawInput: text,
      now: nowDate().toISOString(),
      currentProjects: [...new Set(tasks.listActive().map((item) => item.project))],
    });
    const analyzed = transaction(() => {
      const updated = tasks.update(task.id, {
        title: analysis.title,
        project: analysis.project,
        quadrant: analysis.quadrant,
        importance: analysis.importance,
        urgency: analysis.urgency,
        dueAt: analysis.dueAt,
        estimateMinutes: analysis.estimateMinutes,
        nextAction: analysis.nextAction,
        doneDefinition: analysis.doneDefinition,
        analysisStatus: analysis.analysisStatus,
        status: "ready",
      });
      ops.appendEvent({
        taskId: task.id,
        kind: "task_analyzed",
        payload: {
          project: updated.project,
          importance: updated.importance,
          urgency: updated.urgency,
          analysisStatus: updated.analysisStatus,
        },
        idempotencyKey: `analysis:${messageId}`,
      });
      return updated;
    });

    if (analyzed.urgency === "high" || isDueOn(analyzed, localDate(nowDate(), settings.timezone))) {
      await replanDay({ reason: "urgent_task_added" });
    }
    return tasks.findById(task.id);
  }

  async function handleAction(input) {
    if (input.idempotencyKey) {
      const prior = ops.findEventByIdempotencyKey(input.idempotencyKey);
      if (prior) return { action: "duplicate", task: prior.taskId ? tasks.findById(prior.taskId) : null };
    }

    const resolution = resolveTask(input);
    if (resolution.matches?.length > 1) {
      ops.enqueueOutbox({
        kind: "disambiguation_card",
        payload: {
          action: input.action,
          tasks: resolution.matches.map((task) => ({ id: task.id, title: task.title })),
        },
        idempotencyKey: input.idempotencyKey ? `outbox:${input.idempotencyKey}` : `disambiguation:${Date.now()}`,
      });
      return { action: "disambiguation", matches: resolution.matches };
    }
    if (!resolution.task) {
      ops.enqueueOutbox({
        kind: "status_message",
        payload: { text: `没有找到对应任务：${input.query || input.taskId || "未指定"}` },
        idempotencyKey: input.idempotencyKey ? `outbox:${input.idempotencyKey}` : `not-found:${Date.now()}`,
      });
      return { action: "not_found" };
    }

    const task = resolution.task;
    if (input.action === "complete_checkpoint") {
      const checkpointIndex = Number(input.checkpointIndex);
      if (!Number.isInteger(checkpointIndex) || checkpointIndex < 0) {
        throw new Error("checkpoint index is required");
      }
      const updated = transaction(() => {
        const saved = tasks.completeCheckpoint(task.id, checkpointIndex);
        ops.appendEvent({
          taskId: task.id,
          kind: "checkpoint_completed",
          payload: { checkpointIndex, title: saved.checkpoints[checkpointIndex].title },
          idempotencyKey: input.idempotencyKey || null,
        });
        ops.enqueueOutbox({
          kind: "status_message",
          payload: { text: `已完成关卡：${saved.checkpoints[checkpointIndex].title}\n继续推进：${saved.title}`, taskId: saved.id },
          idempotencyKey: input.idempotencyKey ? `outbox:${input.idempotencyKey}` : `checkpoint:${task.id}:${checkpointIndex}:${Date.now()}`,
        });
        return saved;
      });
      return { action: input.action, task: updated };
    }
    if (input.action === "start") {
      if (task.status === "doing") {
        ops.enqueueOutbox({
          kind: "status_message",
          payload: { text: `已经在进行中：${task.title}`, taskId: task.id },
          idempotencyKey: input.idempotencyKey ? `outbox:${input.idempotencyKey}` : `already-started:${task.id}:${Date.now()}`,
        });
        return { action: "already_started", task };
      }
      const current = tasks.findDoing();
      if (current && current.id !== task.id) {
        ops.enqueueOutbox({
          kind: "current_task_conflict",
          payload: { currentTask: current, requestedTask: task },
          idempotencyKey: input.idempotencyKey ? `outbox:${input.idempotencyKey}` : `conflict:${task.id}:${Date.now()}`,
        });
        return { action: "current_task_conflict", currentTask: current };
      }
    }

    if (input.action === "defer_30" && !String(input.detail || "").trim()) {
      ops.enqueueOutbox({
        kind: "status_message",
        payload: { text: `请说明推迟原因，再执行推迟：\n推迟30分钟：${task.title}｜原因`, taskId: task.id },
        idempotencyKey: input.idempotencyKey ? `outbox:${input.idempotencyKey}` : `defer-reason:${task.id}:${Date.now()}`,
      });
      return { action: "defer_reason_required", task };
    }

    const detail = input.action === "block"
      ? extractBlocker(input.detail || input.query || "", task.title)
      : input.detail || "";
    const transition = transitionTask({
      task,
      action: input.action,
      detail,
      at: nowDate().toISOString(),
    });
    let minimum = null;
    if (input.action === "block") {
      minimum = await analyzer.minimumAction({ task, blocker: detail });
    }

    const updated = transaction(() => {
      const saved = tasks.update(task.id, transition.patch);
      ops.appendEvent({
        taskId: task.id,
        kind: transition.event.kind,
        payload: {
          ...transition.event.payload,
          minimumAction: minimum?.action || null,
        },
        idempotencyKey: input.idempotencyKey || null,
      });
      if (minimum) {
        ops.enqueueOutbox({
          kind: "intervention_card",
          payload: { task: saved, minimumAction: minimum.action, minutes: 15 },
          idempotencyKey: input.idempotencyKey ? `outbox:${input.idempotencyKey}` : `blocked:${task.id}:${Date.now()}`,
        });
      } else {
        ops.enqueueOutbox({
          kind: "status_message",
          payload: { text: renderStatusMessage(input.action, saved), taskId: saved.id },
          idempotencyKey: input.idempotencyKey ? `outbox:${input.idempotencyKey}` : `status:${task.id}:${Date.now()}`,
        });
      }
      return saved;
    });

    if (["start", "complete", "block"].includes(input.action)) ops.cancelPendingReminders(task.id);
    if (input.action === "defer_30") {
      ops.enqueueReminder({
        taskId: task.id,
        kind: "defer_resume",
        dueAt: new Date(nowDate().getTime() + 30 * 60_000).toISOString(),
        idempotencyKey: `defer-resume:${task.id}:${input.idempotencyKey || nowDate().toISOString()}`,
      });
    }
    if (input.action === "complete") enqueueFeishuTaskCompletion(updated);
    await replanDay({ reason: `task_${input.action}` });
    return { action: input.action, task: tasks.findById(task.id), minimumAction: minimum };
  }

  async function replanDay({ reason = "manual", date = null, now = null } = {}) {
    const currentNow = now ? new Date(now) : nowDate();
    const scheduleDate = date || localDate(currentNow, settings.timezone);
    const activeTasks = tasks.listActive().filter((task) => task.status !== "deferred");
    const result = buildDailySchedule({
      date: scheduleDate,
      now: currentNow.toISOString(),
      tasks: activeTasks,
      settings,
    });

    for (const task of activeTasks) ops.cancelPendingReminders(task.id);
    const stored = ops.replaceSchedule({ date: scheduleDate, blocks: result.blocks });
    const selectedIds = new Set(result.blocks.map((block) => block.taskId));
    for (const taskId of selectedIds) {
      const selectedTask = tasks.findById(taskId);
      if (["inbox", "open", "ready", "deferred"].includes(selectedTask.status)) {
        tasks.update(taskId, { status: "scheduled" });
      }
      if (!ops.getSetting(`feishu_task_guid:${taskId}`)) {
        ops.enqueueOutbox({
          kind: "feishu_task_create",
          payload: {
            action: "create",
            localTaskId: taskId,
            task: {
              summary: selectedTask.title,
              description: `${selectedTask.nextAction}\n\n完成标准：${selectedTask.doneDefinition}`,
              dueDate: selectedTask.dueAt?.slice(0, 10) || scheduleDate,
            },
          },
          idempotencyKey: `feishu-task-create:${taskId}`,
        });
      }
    }

    for (const block of stored.blocks) {
      const task = tasks.findById(block.taskId);
      reminderEngine.scheduleTask(task, block.startsAt, stored.version, settings.noResponseMinutes || 15);
    }
    const enriched = stored.blocks.map((block) => {
      const task = tasks.findById(block.taskId);
      return {
        ...task,
        taskId: task.id,
        startsAt: localTime(block.startsAt, settings.timezone),
        endsAt: localTime(block.endsAt, settings.timezone),
        reason: block.reason,
      };
    });
    const isDailyPlan = reason === "daily_plan";
    ops.enqueueOutbox({
      kind: isDailyPlan ? "daily_plan_card" : "replan_card",
      payload: {
        card: renderDailyPlanCard({ date: scheduleDate, blocks: enriched }),
        changed: reason,
        reason,
      },
      idempotencyKey: `${isDailyPlan ? "daily-plan" : "replan"}:${scheduleDate}:${stored.version}`,
    });
    ops.appendEvent({
      kind: isDailyPlan ? "daily_plan_created" : "schedule_replanned",
      payload: { date: scheduleDate, version: stored.version, reason, taskIds: [...selectedIds] },
      idempotencyKey: `schedule-event:${scheduleDate}:${stored.version}`,
    });
    return { ...stored, deferred: result.deferred, reasons: result.reasons };
  }

  async function resumeDeferredTask(taskId) {
    const task = tasks.findById(taskId);
    if (!task || task.status !== "deferred") return null;
    tasks.update(task.id, { status: "ready" });
    ops.appendEvent({ taskId, kind: "task_resumed_after_defer", payload: {} });
    await replanDay({ reason: "defer_elapsed" });
    return tasks.findById(taskId);
  }

  async function runMiddayCheck(options = {}) {
    const schedule = await replanDay({ ...options, reason: "midday_check" });
    ops.appendEvent({
      kind: "midday_checked",
      payload: { date: schedule.date, version: schedule.version },
      idempotencyKey: `midday:${schedule.date}:${schedule.version}`,
    });
    return schedule;
  }

  async function runDayClose(options = {}) {
    const schedule = await replanDay({ ...options, reason: "day_close" });
    ops.appendEvent({
      kind: "day_closed",
      payload: { date: schedule.date, version: schedule.version },
      idempotencyKey: `day-close:${schedule.date}:${schedule.version}`,
    });
    return schedule;
  }

  function enqueueFeishuTaskCompletion(task) {
    const taskGuid = ops.getSetting(`feishu_task_guid:${task.id}`);
    if (!taskGuid) return;
    ops.enqueueOutbox({
      kind: "feishu_task_update",
      payload: {
        action: "update",
        localTaskId: task.id,
        taskGuid,
        patch: { completedAt: nowDate().toISOString() },
      },
      idempotencyKey: `feishu-task-complete:${task.id}`,
    });
  }

  function resolveTask(input) {
    if (input.taskId) return { task: tasks.findById(input.taskId), matches: [] };
    const query = String(input.query || "").trim();
    if (!query) return { task: null, matches: [] };
    const includeDone = input.action === "restore";
    const pool = includeDone
      ? [...tasks.listActive(), ...tasks.listByStatus("done")]
      : tasks.listActive();
    const matches = pool.filter((task) =>
      task.title === query || task.title.includes(query) || query.includes(task.title),
    );
    if (matches.length === 1) return { task: matches[0], matches };
    return { task: null, matches };
  }

  return {
    ingest,
    handleAction,
    replanDay,
    dispatchDay: (options = {}) => replanDay({ ...options, reason: "daily_plan" }),
    runMiddayCheck,
    runDayClose,
    resumeDeferredTask,
  };
}

function renderStatusMessage(action, task) {
  const messages = {
    start: `开始执行：${task.title}`,
    complete: `已完成：${task.title}`,
    defer: `已延期：${task.title}`,
    defer_30: `已推迟 30 分钟：${task.title}`,
    restore: `已恢复到任务池：${task.title}`,
    cancel: `已取消：${task.title}`,
  };
  return messages[action] || `任务已更新：${task.title}`;
}

function extractBlocker(value, title) {
  const text = String(value || "").trim();
  return text.startsWith(title) ? text.slice(title.length).trim() : text;
}

function isDueOn(task, date) {
  return Boolean(task.dueAt && task.dueAt.slice(0, 10) === date);
}

function localDate(date, timezone) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone || "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function localTime(value, timezone) {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: timezone || "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(value));
}
