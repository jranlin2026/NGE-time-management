import { daysBetween, parseDate } from "./date.mjs";

const importanceScore = { S: 80, A: 60, B: 35, C: 10 };
const urgencyScore = { high: 25, medium: 10, low: 0 };
const quadrantScore = {
  "重要且紧急": 50,
  "重要紧急": 50,
  "重要不紧急": 25,
  "不重要但紧急": 5,
  "不重要紧急": 5,
  "不重要不紧急": -20,
};

export function scoreTask(task, today = new Date()) {
  if (task.status && !["open", "doing", "blocked"].includes(task.status)) return -999;

  let score = 0;
  score += importanceScore[task.importance] ?? 30;
  score += urgencyScore[task.urgency] ?? 0;
  score += quadrantScore[task.quadrant] ?? 0;
  score += Number(task.procrastinationCount || 0) * 4;

  const due = parseDate(task.due);
  if (due) {
    const days = daysBetween(due, today);
    if (days < 0) score += 60;
    else if (days === 0) score += 55;
    else if (days <= 2) score += 40;
    else if (days <= 7) score += 20;
    else if (days <= 30) score += 5;
  }

  return score;
}

export function pickDailyTasks(tasks, today = new Date(), limit = 3) {
  return tasks
    .map((task) => ({ task, score: scoreTask(task, today) }))
    .filter((item) => item.score > -100)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

export function inferQuadrant({ importance = "A", due = "", urgency = "" }, today = new Date()) {
  const dueDate = parseDate(due);
  const isImportant = ["S", "A"].includes(importance);
  const isUrgent = urgency === "high" || (dueDate && daysBetween(dueDate, today) <= 2);
  if (isImportant && isUrgent) return "重要且紧急";
  if (isImportant) return "重要不紧急";
  if (isUrgent) return "不重要但紧急";
  return "不重要不紧急";
}
