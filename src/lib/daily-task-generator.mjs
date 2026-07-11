export function createDailyTaskGenerator({ tasks, projectOps }) {
  return { materialize };

  async function materialize({ weekId, date }) {
    const row = projectOps.getConfirmedWeeklyPlan(weekId);
    if (!row) return [];
    return (row.plan.tasks || [])
      .filter((item) => item.suggestedDate === date)
      .map((item) => tasks.create({
        id: `weekly:${weekId}:${item.taskId}`,
        rawInput: item.title,
        title: item.title,
        project: item.projectName,
        projectId: item.projectId,
        milestoneId: item.milestoneId,
        deliverableId: item.deliverableId,
        requiresEvidence: item.requiresEvidence,
        impact: item.impact,
        estimateMinutes: item.estimateMinutes,
        nextAction: item.nextAction,
        doneDefinition: item.completionStandard ?? item.doneDefinition,
        status: "ready",
      }));
  }
}

export function isoWeekId(date) {
  const value = new Date(`${date}T00:00:00.000Z`);
  const day = value.getUTCDay() || 7;
  value.setUTCDate(value.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(value.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((value - yearStart) / 86_400_000) + 1) / 7);
  return `${value.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}
