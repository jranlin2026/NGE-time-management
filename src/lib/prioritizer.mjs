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

export function scoreTask(task, today = new Date(), options = {}) {
  return scoreTaskDetails(task, today, options).score;
}

export function scoreTaskDetails(task, today = new Date(), options = {}) {
  if (task.status && !["open", "inbox", "ready", "scheduled", "doing", "blocked", "deferred"].includes(task.status)) {
    return { score: -999, factors: [] };
  }

  let score = 0;
  const factors = [];
  const importance = importanceScore[task.importance] ?? 30;
  const urgency = urgencyScore[task.urgency] ?? 0;
  const quadrant = quadrantScore[task.quadrant] ?? 0;
  const procrastination = Number(task.procrastinationCount || 0) * 4;
  score += importance + urgency + quadrant + procrastination;
  if (importance) factors.push({ label: `重要性${task.importance || "默认"}`, points: importance });
  if (urgency) factors.push({ label: `紧急度${task.urgency}`, points: urgency });
  if (quadrant) factors.push({ label: task.quadrant, points: quadrant });
  if (procrastination) factors.push({ label: `拖延${task.procrastinationCount}次`, points: procrastination });

  const due = parseTaskDue(task);
  if (due) {
    const days = daysBetween(due, today);
    const duePoints = days < 0 ? 60 : days === 0 ? 55 : days <= 2 ? 40 : days <= 7 ? 20 : days <= 30 ? 5 : 0;
    score += duePoints;
    if (duePoints) factors.push({ label: days < 0 ? "已逾期" : `截止剩余${days}天`, points: duePoints });
  }

  for (const boost of options.projectBoosts || []) {
    if (boost.project !== task.project) continue;
    const date = options.date || formatLocalDate(today);
    if (boost.startsOn && date < boost.startsOn) continue;
    if (boost.endsOn && date > boost.endsOn) continue;
    const points = Number(boost.points || 0);
    score += points;
    if (points) factors.push({ label: `${task.project}阶段优先`, points });
  }

  return { score, factors: factors.sort((a, b) => b.points - a.points) };
}

export function pickDailyTasks(tasks, today = new Date(), limit = 3) {
  return tasks
    .map((task) => ({ task, score: scoreTask(task, today) }))
    .filter((item) => item.score > -100)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

function parseTaskDue(task) {
  const dateOnly = parseDate(task.due);
  if (dateOnly) return dateOnly;
  if (!task.dueAt) return null;
  const value = new Date(task.dueAt);
  return Number.isNaN(value.getTime()) ? null : value;
}

function formatLocalDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
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
