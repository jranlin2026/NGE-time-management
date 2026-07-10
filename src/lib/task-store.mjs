import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { formatDate } from "./date.mjs";

const TASK_START = "<!-- task:";
const TASK_END = "<!-- /task -->";

export function taskFile(kbDir) {
  return path.join(kbDir, "任务数据", "active-tasks.md");
}

export async function ensureTaskStore(kbDir) {
  const file = taskFile(kbDir);
  await fs.mkdir(path.dirname(file), { recursive: true });
  try {
    await fs.access(file);
  } catch {
    await fs.writeFile(
      file,
      [
        "# Active Tasks",
        "",
        "这里是时间管理大师使用的结构化任务池。可以手工编辑，但请保留每个任务的字段格式。",
        "",
      ].join("\n"),
      "utf8",
    );
  }
  return file;
}

export async function readTasks(kbDir) {
  const file = await ensureTaskStore(kbDir);
  const content = await fs.readFile(file, "utf8");
  const blocks = content.match(/<!-- task:[\s\S]*?<!-- \/task -->/g) || [];
  return blocks.map(parseTaskBlock).filter(Boolean);
}

export async function writeTasks(kbDir, tasks) {
  const file = await ensureTaskStore(kbDir);
  const header = [
    "# Active Tasks",
    "",
    "这里是时间管理大师使用的结构化任务池。可以手工编辑，但请保留每个任务的字段格式。",
    "",
  ].join("\n");
  const body = tasks.map(serializeTask).join("\n\n");
  await fs.writeFile(file, `${header}${body}${body ? "\n" : ""}`, "utf8");
  return file;
}

export async function addTask(kbDir, input) {
  const tasks = await readTasks(kbDir);
  const task = normalizeTask(input);
  tasks.push(task);
  await writeTasks(kbDir, tasks);
  return task;
}

export function normalizeTask(input) {
  const now = formatDate();
  return {
    id: input.id || randomUUID(),
    title: clean(input.title || input.text || "未命名任务"),
    project: clean(input.project || "未归类"),
    quadrant: clean(input.quadrant || "重要不紧急"),
    importance: clean(input.importance || "A"),
    urgency: clean(input.urgency || "medium"),
    due: clean(input.due || ""),
    status: clean(input.status || "open"),
    nextAction: clean(input.nextAction || input.next || "拆出下一步动作"),
    doneDefinition: clean(input.doneDefinition || input.done || "完成后更新状态"),
    estimateMinutes: Number(input.estimateMinutes || input.estimate || 45),
    procrastinationCount: Number(input.procrastinationCount || 0),
    blocker: clean(input.blocker || ""),
    created: clean(input.created || now),
    updated: clean(input.updated || now),
  };
}

function parseTaskBlock(block) {
  const lines = block.split(/\r?\n/);
  const idMatch = lines[0]?.match(/<!-- task:([^ ]+) -->/);
  const task = { id: idMatch?.[1] || "" };
  for (const line of lines) {
    const field = line.match(/^- ([a-zA-Z][a-zA-Z0-9]*):\s*(.*)$/);
    if (field) task[field[1]] = field[2].trim();
  }
  if (!task.title) {
    const title = block.match(/^##\s+(.+)$/m);
    task.title = title?.[1]?.replace(/^\[[^\]]+\]\s*/, "") || "";
  }
  return task.title ? normalizeTask(task) : null;
}

function serializeTask(task) {
  const t = normalizeTask(task);
  return [
    `${TASK_START}${t.id} -->`,
    `## [${t.status}] ${t.title}`,
    `- id: ${t.id}`,
    `- title: ${t.title}`,
    `- project: ${t.project}`,
    `- quadrant: ${t.quadrant}`,
    `- importance: ${t.importance}`,
    `- urgency: ${t.urgency}`,
    `- due: ${t.due}`,
    `- status: ${t.status}`,
    `- nextAction: ${t.nextAction}`,
    `- doneDefinition: ${t.doneDefinition}`,
    `- estimateMinutes: ${t.estimateMinutes}`,
    `- procrastinationCount: ${t.procrastinationCount}`,
    `- blocker: ${t.blocker}`,
    `- created: ${t.created}`,
    `- updated: ${formatDate()}`,
    TASK_END,
  ].join("\n");
}

function clean(value) {
  return String(value ?? "").replace(/\r?\n/g, " ").trim();
}
