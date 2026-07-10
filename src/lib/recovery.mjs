export async function recoverManagerState({ now, date, tasks, ops, replan }) {
  ops.expireStaleReminders(now);
  for (const reminder of ops.listReminders({ status: "pending" })) {
    if (reminder.dueAt <= now) {
      ops.updateReminder(reminder.id, { status: "expired" });
    }
  }

  const currentTask = tasks.findDoing();
  const schedule = await replan({
    currentTask,
    reason: "recovery",
    now,
    date,
  });
  const version = schedule?.version || 1;
  ops.enqueueOutbox({
    kind: "recovery_plan_card",
    payload: {
      date,
      currentTask,
      blocks: schedule?.blocks || [],
      reason: "Mac 或服务恢复后重新计算当前计划",
    },
    idempotencyKey: `recovery:${date}:${version}`,
  });
  ops.appendEvent({
    kind: "manager_recovered",
    payload: { date, scheduleVersion: version, currentTaskId: currentTask?.id || null },
    idempotencyKey: `recovery-event:${date}:${version}`,
  });

  return { currentTask, schedule };
}
