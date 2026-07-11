export function weeklyTaskToDailyTask({ weekId, task }) {
  return {
    id: `weekly:${weekId}:${task.taskId}`,
    rawInput: task.title,
    title: task.title,
    project: task.projectName,
    projectId: task.projectId,
    milestoneId: task.milestoneId,
    deliverableId: task.deliverableId,
    requiresEvidence: task.requiresEvidence,
    impact: task.impact,
    estimateMinutes: task.minutes,
    nextAction: task.title,
    doneDefinition: task.completionStandard,
    status: "ready",
  };
}
