import { readTasks } from "./task-store.mjs";
import { writeDailyPlan, renderFeishuPlanWithTaskLink } from "./daily-plan.mjs";
import { sendFeishuText } from "./feishu.mjs";
import { createDailyTaskBundle } from "./feishu-tasks.mjs";
import { formatDate } from "./date.mjs";

export async function dispatchToday(config, date = new Date()) {
  const tasks = await readTasks(config.kbDir);
  const result = await writeDailyPlan(config.kbDir, tasks, date);
  const dateText = formatDate(date);
  const taskResult = await createDailyTaskBundle(config, result.picked, dateText);
  const text = renderFeishuPlanWithTaskLink(result.picked, taskResult, dateText);
  const feishu = await sendFeishuText(config, text);
  return {
    ok: true,
    file: result.file,
    picked: result.picked.map((item) => item.task.title),
    feishuTasks: taskResult,
    feishu,
  };
}
