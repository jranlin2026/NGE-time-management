import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { renderDailyReview } from "./daily-review.mjs";

export async function exportDay({ exportDir, date, schedule, review }) {
  await fs.mkdir(exportDir, { recursive: true });
  const planFile = path.join(exportDir, `${date}-plan.md`);
  const reviewFile = path.join(exportDir, `${date}-review.md`);
  await atomicWrite(planFile, renderSchedule(date, schedule));
  await atomicWrite(reviewFile, renderDailyReview(review));
  return { planFile, reviewFile };
}

function renderSchedule(date, schedule) {
  const lines = [`# ${date} 每日计划`, ""];
  if (!schedule?.blocks?.length) {
    lines.push("当前没有已安排任务。", "");
    return lines.join("\n");
  }
  for (const block of schedule.blocks) {
    lines.push(
      `- 任务 ${block.title || block.taskId}`,
      `  - 时间：${block.startsAt || "未设置"} 至 ${block.endsAt || "未设置"}`,
      `  - 原因：${block.reason || "当前综合优先级"}`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

async function atomicWrite(file, content) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, content, "utf8");
  await fs.rename(temporary, file);
}
