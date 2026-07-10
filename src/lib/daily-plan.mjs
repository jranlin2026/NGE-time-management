import fs from "node:fs/promises";
import path from "node:path";
import { formatDate } from "./date.mjs";
import { pickDailyTasks } from "./prioritizer.mjs";

export async function writeDailyPlan(kbDir, tasks, date = new Date()) {
  const dateText = formatDate(date);
  const picked = pickDailyTasks(tasks, date, 3);
  const dir = path.join(kbDir, "每日计划");
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${dateText}.md`);
  const content = renderDailyPlan(dateText, picked);
  await fs.writeFile(file, content, "utf8");
  return { file, picked, content };
}

export function renderDailyPlan(dateText, picked) {
  const lines = [
    `# ${dateText} 每日计划`,
    "",
    "## 今日原则",
    "",
    "今天最多锁定 3 个关键任务。先推进重要且紧急，再推进重要不紧急；不重要不紧急默认不进入主计划。",
    "",
  ];

  if (!picked.length) {
    lines.push("## 今日关键任务", "", "当前任务池没有可调度任务。", "");
    return lines.join("\n");
  }

  picked.forEach(({ task, score }, index) => {
    lines.push(
      `## 关键任务 ${index + 1}：${task.title}`,
      "",
      `项目：${task.project}`,
      "",
      `分类：${task.quadrant}`,
      "",
      `截止时间：${task.due || "未设置"}`,
      "",
      `评分：${score}`,
      "",
      `预计耗时：${task.estimateMinutes} 分钟`,
      "",
      "下一步动作：",
      "",
      "```text",
      task.nextAction,
      "```",
      "",
      "完成标准：",
      "",
      "```text",
      task.doneDefinition,
      "```",
      "",
      "拖延降级版本：",
      "",
      "```text",
      makeFallback(task),
      "```",
      "",
    );
  });

  return lines.join("\n");
}

export function renderFeishuPlan(picked, dateText = formatDate()) {
  if (!picked.length) return `${dateText} 今日暂无关键任务。`;
  const body = picked
    .map(({ task }, index) => {
      return [
        `${index + 1}. ${task.title}`,
        `项目：${task.project}`,
        `分类：${task.quadrant}`,
        `下一步：${task.nextAction}`,
        `完成标准：${task.doneDefinition}`,
      ].join("\n");
    })
    .join("\n\n");
  return [`${dateText} 今日关键任务`, "", body, "", "规则：先做第 1 件。完成或卡住，都直接回复我。"].join("\n");
}

export function renderFeishuPlanWithTaskLink(picked, taskResult, dateText = formatDate()) {
  const plan = renderFeishuPlan(picked, dateText);
  if (taskResult?.parentUrl) {
    const warning = taskResult.warnings?.length
      ? `\n\n注意：任务已创建，但加入任务清单失败：${taskResult.warnings[0]}`
      : "";
    return `${plan}\n\n飞书任务已创建：${taskResult.parentUrl}${warning}`;
  }
  if (taskResult?.skipped) {
    return `${plan}\n\n飞书任务清单未创建：${taskResult.reason}`;
  }
  return plan;
}

function makeFallback(task) {
  const minutes = Math.min(15, Number(task.estimateMinutes || 15));
  return `${minutes} 分钟内只做最小推进：${task.nextAction}`;
}
