import { transitionTask } from "./task-state-machine.mjs";

export function createReminderEngine({ tasks, ops, analyzer, replan, clock, handlers = {} }) {
  const nowDate = () => clock?.now?.() || new Date();

  function scheduleTask(task, startsAt, scheduleVersion, noResponseMinutes = 15) {
    const start = new Date(startsAt);
    const first = new Date(start.getTime() + noResponseMinutes * 60_000);
    const second = new Date(start.getTime() + noResponseMinutes * 2 * 60_000);
    const prefix = `${task.id}:${scheduleVersion}:${startsAt}`;
    return [
      ops.enqueueReminder({
        taskId: task.id,
        kind: "task_start",
        dueAt: start.toISOString(),
        idempotencyKey: `task-start:${prefix}`,
      }),
      ops.enqueueReminder({
        taskId: task.id,
        kind: "no_response_1",
        dueAt: first.toISOString(),
        idempotencyKey: `no-response-1:${prefix}`,
      }),
      ops.enqueueReminder({
        taskId: task.id,
        kind: "no_response_2",
        dueAt: second.toISOString(),
        idempotencyKey: `no-response-2:${prefix}`,
      }),
    ];
  }

  async function processDue() {
    const now = nowDate();
    const reminders = ops.dueReminders(now.toISOString());
    let processed = 0;
    for (const reminder of reminders) {
      ops.updateReminder(reminder.id, {
        status: "processing",
        attempt: reminder.attempt + 1,
      });
      try {
        await handleReminder(reminder, now);
        ops.updateReminder(reminder.id, { status: "fired", firedAt: now.toISOString() });
      } catch (error) {
        ops.updateReminder(reminder.id, {
          status: "pending",
          dueAt: new Date(now.getTime() + 5 * 60_000).toISOString(),
        });
        ops.appendEvent({
          taskId: reminder.taskId,
          kind: "reminder_failed",
          payload: { reminderId: reminder.id, error: String(error?.message || error).slice(0, 300) },
          idempotencyKey: `reminder-failed:${reminder.id}:${reminder.attempt + 1}`,
        });
      }
      processed += 1;
    }
    return processed;
  }

  async function handleReminder(reminder, now) {
    if (handlers[reminder.kind]) {
      await handlers[reminder.kind](reminder, now);
      return;
    }
    const task = reminder.taskId ? tasks.findById(reminder.taskId) : null;
    if (!task) return;

    if (reminder.kind === "task_start") {
      ops.appendEvent({
        taskId: task.id,
        kind: "task_start_reminded",
        payload: { reminderId: reminder.id },
        idempotencyKey: `event:${reminder.id}`,
      });
      ops.enqueueOutbox({
        kind: "current_task_card",
        payload: { task },
        idempotencyKey: `outbox:${reminder.id}`,
      });
      return;
    }

    if (!["ready", "scheduled"].includes(task.status)) return;

    if (reminder.kind === "no_response_1") {
      ops.appendEvent({
        taskId: task.id,
        kind: "no_response_1",
        payload: { reminderId: reminder.id },
        idempotencyKey: `event:${reminder.id}`,
      });
      ops.enqueueOutbox({
        kind: "no_response_message",
        payload: { taskId: task.id, title: task.title, mentionOwner: true },
        idempotencyKey: `outbox:${reminder.id}`,
      });
      return;
    }

    if (reminder.kind === "no_response_2") {
      const transition = transitionTask({
        task,
        action: "no_response_2",
        at: now.toISOString(),
      });
      const updated = tasks.update(task.id, transition.patch);
      const minimum = await analyzer.minimumAction({ task: updated, blocker: "连续两次未响应" });
      ops.appendEvent({
        taskId: task.id,
        kind: transition.event.kind,
        payload: { ...transition.event.payload, minimumAction: minimum.action },
        idempotencyKey: `event:${reminder.id}`,
      });
      ops.enqueueOutbox({
        kind: "intervention_card",
        payload: {
          task: updated,
          minimumAction: minimum.action,
          minutes: 15,
          coachText: "你这效率也太低了。现在别追求完美，只完成接下来的 15 分钟。",
        },
        idempotencyKey: `outbox:${reminder.id}`,
      });
      await replan({ task: updated, reason: "no_response_2", now: now.toISOString() });
    }
  }

  return { scheduleTask, processDue };
}
