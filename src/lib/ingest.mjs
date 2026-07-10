import { addTask } from "./task-store.mjs";
import { inferQuadrant } from "./prioritizer.mjs";

export async function ingestNaturalTask(kbDir, text) {
  const parsed = parseNaturalTask(text);
  parsed.quadrant = parsed.quadrant || inferQuadrant(parsed);
  return addTask(kbDir, parsed);
}

export function parseNaturalTask(text) {
  const value = String(text || "").trim();
  const due = extractDue(value);
  const importance = /必须|一定|重要|客户|成交|交付|直播|收款|现金流/.test(value) ? "A" : "B";
  const urgency = /今天|明天|截止|马上|立刻|本周|下周|紧急/.test(value) ? "high" : "medium";
  const project = extractProject(value);
  return {
    title: value.replace(/^新增任务[:：]\s*/, "").slice(0, 80),
    project,
    importance,
    urgency,
    due,
    nextAction: "把任务拆成一个 15-30 分钟可以开始的动作",
    doneDefinition: "明确产出物并更新完成状态",
    estimateMinutes: 45,
  };
}

function extractProject(text) {
  if (/直播|AI获客|私域/.test(text)) return "7月8日AI获客变现实战课";
  if (/CRM|极享OS|数据迁移/.test(text)) return "极享OS/CRM";
  if (/IP|短视频|内容/.test(text)) return "个人IP";
  if (/出海/.test(text)) return "项目出海";
  return "未归类";
}

function extractDue(text) {
  const iso = text.match(/20\d{2}-\d{2}-\d{2}/);
  if (iso) return iso[0];
  const slash = text.match(/20\d{2}[\/年](\d{1,2})[\/月](\d{1,2})/);
  if (slash) {
    const year = text.match(/20\d{2}/)?.[0];
    return `${year}-${slash[1].padStart(2, "0")}-${slash[2].padStart(2, "0")}`;
  }
  if (/7月8日/.test(text)) return "2026-07-08";
  return "";
}
