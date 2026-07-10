const DEFAULT_RECOMMENDATION =
  "明天先继续最高优先级的未完成任务；开始前只看下一步动作，不重新整理全部计划。";

export function buildDailyReview({ date, tasks, schedule, events }) {
  const plannedIds = [...new Set((schedule?.blocks || []).map((block) => block.taskId))];
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const plannedTasks = plannedIds.map((id) => taskById.get(id)).filter(Boolean);
  const criticalCompleted = plannedTasks.filter((task) => task.status === "done").length;
  const criticalPlanned = plannedIds.length;
  const deferredTitles = tasks
    .filter((task) => task.status === "deferred")
    .map((task) => task.title);
  const tomorrowCandidates = tasks
    .filter((task) => ["deferred", "blocked", "ready", "scheduled", "doing"].includes(task.status))
    .map((task) => task.title);
  const changes = [...new Set(
    events
      .filter((event) => event.kind === "schedule_replanned")
      .map((event) => event.payload?.reason)
      .filter(Boolean),
  )];

  return {
    date,
    criticalPlanned,
    criticalCompleted,
    completionRate: criticalPlanned ? Math.round((criticalCompleted / criticalPlanned) * 100) : 0,
    procrastinationCount: events.filter((event) => event.kind === "procrastination_recorded").length,
    blockedCount: events.filter((event) => event.kind === "task_blocked").length,
    deferredTitles,
    tomorrowCandidates: [...new Set(tomorrowCandidates)],
    changes,
    recommendation: DEFAULT_RECOMMENDATION,
  };
}

export function renderDailyReview(summary) {
  const lines = [
    `# ${summary.date} 晚间复盘`,
    "",
    `今日完成度：${summary.completionRate}%`,
    `完成 ${summary.criticalCompleted}/${summary.criticalPlanned} 个关键任务。`,
    `拖延：${summary.procrastinationCount} 次。`,
    `卡住：${summary.blockedCount} 次。`,
    "",
    "## 延期任务",
    "",
    ...(summary.deferredTitles.length ? summary.deferredTitles.map((title) => `- ${title}`) : ["- 无"]),
    "",
    "## 调度变化",
    "",
    ...(summary.changes.length ? summary.changes.map((reason) => `- ${reason}`) : ["- 无"]),
    "",
    "## 明日候选",
    "",
    ...(summary.tomorrowCandidates.length
      ? summary.tomorrowCandidates.map((title) => `- ${title}`)
      : ["- 暂无"]),
    "",
    "## 系统建议",
    "",
    summary.recommendation,
    "",
  ];
  return lines.join("\n");
}
