import { weeklyTaskToDailyTask } from "./weekly-task-adapter.mjs";

export function createDailyTaskGenerator({ tasks, projectOps }) {
  return { materialize };

  async function materialize({ weekId, date }) {
    const row = projectOps.getConfirmedWeeklyPlan(weekId);
    if (!row) return [];
    return (row.plan.tasks || [])
      .filter((item) => item.date === date)
      .map((item) => tasks.create(weeklyTaskToDailyTask({ weekId, task: item })));
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
