import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const TASK_SCHEMA = fileURLToPath(new URL("./codex-task-schema.json", import.meta.url));
const MINIMUM_ACTION_SCHEMA = fileURLToPath(
  new URL("./codex-minimum-action-schema.json", import.meta.url),
);

const QUADRANTS = new Set(["重要且紧急", "重要不紧急", "不重要但紧急", "不重要不紧急"]);
const IMPORTANCE = new Set(["S", "A", "B", "C"]);
const URGENCY = new Set(["high", "medium", "low"]);

export function createCodexAnalyzer(config = {}, deps = {}) {
  const run = deps.run || ((input) => runCodex(config, input));

  return {
    async analyzeTask({ rawInput, now = new Date().toISOString(), currentProjects = [] }) {
      try {
        const text = await run({
          mode: "task_analysis",
          schemaPath: TASK_SCHEMA,
          prompt: buildTaskPrompt({
            rawInput,
            now,
            timezone: config.timezone || "Asia/Shanghai",
            currentProjects,
          }),
        });
        const parsed = JSON.parse(text);
        validateTaskAnalysis(parsed);
        return { ...parsed, analysisStatus: "complete" };
      } catch (error) {
        return {
          ...fallbackTaskAnalysis(rawInput),
          analysisError: String(error?.message || error).slice(0, 500),
        };
      }
    },

    async minimumAction({ task, blocker = "" }) {
      try {
        const text = await run({
          mode: "minimum_action",
          schemaPath: MINIMUM_ACTION_SCHEMA,
          prompt: buildMinimumActionPrompt({ task, blocker }),
        });
        const parsed = JSON.parse(text);
        validateMinimumAction(parsed);
        return parsed;
      } catch {
        return { action: task?.nextAction || "先做当前任务的第一个可见动作", minutes: 15 };
      }
    },
  };
}

export function fallbackTaskAnalysis(rawInput) {
  return {
    intent: "create_task",
    title: String(rawInput || "未命名任务").trim().replace(/\r?\n/g, " ").slice(0, 80),
    project: "未归类",
    quadrant: "重要不紧急",
    importance: "B",
    urgency: "medium",
    dueAt: null,
    estimateMinutes: 30,
    nextAction: "先做 15 分钟，明确第一个可交付动作",
    doneDefinition: "提交明确产出并反馈完成",
    confidence: 0,
    analysisStatus: "failed",
  };
}

export async function runCodex(config, { prompt, schemaPath }) {
  const temporaryEmptyDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "time-manager-codex-"));
  const outputPath = path.join(temporaryEmptyDirectory, "result.json");
  const codexBin = config.codexBin || "/Applications/ChatGPT.app/Contents/Resources/codex";
  const timeoutMs = Number(config.codexTimeoutMs || 45_000);

  try {
    const args = [
      "exec",
      "--ephemeral",
      "--sandbox",
      "read-only",
      "--skip-git-repo-check",
      "--output-schema",
      schemaPath,
      "--output-last-message",
      outputPath,
      "--cd",
      temporaryEmptyDirectory,
      prompt,
    ];
    await spawnAndWait(codexBin, args, { cwd: temporaryEmptyDirectory, timeoutMs });
    return await fs.readFile(outputPath, "utf8");
  } finally {
    await fs.rm(temporaryEmptyDirectory, { recursive: true, force: true });
  }
}

function spawnAndWait(command, args, { cwd, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ["ignore", "ignore", "pipe"],
      shell: false,
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-4000);
    });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`Codex timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`Codex exited with code ${code}: ${stderr.trim()}`));
    });
  });
}

function buildTaskPrompt({ rawInput, now, timezone, currentProjects }) {
  return [
    "你是个人时间管理系统中的任务分析器。只分析输入，不执行任务、不修改文件、不发送消息。",
    `根据当前时间和 ${timezone} 时区，把用户原话转换为 JSON Schema 要求的结构。`,
    "不要编造客户、金额、负责人或硬截止时间。缺少截止时间时返回 null。",
    "下一步必须能在 5-30 分钟内开始，完成标准必须是可观察的产出。",
    `当前时间：${now}`,
    `当前项目：${JSON.stringify(currentProjects)}`,
    `用户原话：${JSON.stringify(String(rawInput || ""))}`,
  ].join("\n");
}

function buildMinimumActionPrompt({ task, blocker }) {
  return [
    "你是个人时间管理系统中的拖延干预器。只返回一个 15 分钟内能完成的最小动作。",
    "动作必须具体、可观察，不得要求整理全部计划或切换项目。",
    `任务：${JSON.stringify({
      title: task?.title,
      nextAction: task?.nextAction,
      doneDefinition: task?.doneDefinition,
    })}`,
    `卡点：${JSON.stringify(String(blocker || ""))}`,
  ].join("\n");
}

function validateTaskAnalysis(value) {
  const required = [
    "intent", "title", "project", "quadrant", "importance", "urgency", "dueAt",
    "estimateMinutes", "nextAction", "doneDefinition", "confidence",
  ];
  for (const field of required) {
    if (!(field in value)) throw new Error(`missing field: ${field}`);
  }
  if (value.intent !== "create_task") throw new Error("intent must be create_task");
  if (!String(value.title).trim() || String(value.title).length > 80) throw new Error("invalid title");
  if (!String(value.project).trim()) throw new Error("invalid project");
  if (!QUADRANTS.has(value.quadrant)) throw new Error("invalid quadrant");
  if (!IMPORTANCE.has(value.importance)) throw new Error("invalid importance");
  if (!URGENCY.has(value.urgency)) throw new Error("invalid urgency");
  if (value.dueAt !== null && Number.isNaN(Date.parse(value.dueAt))) throw new Error("invalid dueAt");
  if (!Number.isInteger(value.estimateMinutes) || value.estimateMinutes < 5 || value.estimateMinutes > 480) {
    throw new Error("invalid estimateMinutes");
  }
  if (!String(value.nextAction).trim()) throw new Error("invalid nextAction");
  if (!String(value.doneDefinition).trim()) throw new Error("invalid doneDefinition");
  if (typeof value.confidence !== "number" || value.confidence < 0 || value.confidence > 1) {
    throw new Error("invalid confidence");
  }
}

function validateMinimumAction(value) {
  if (!value || typeof value !== "object") throw new Error("minimum action must be an object");
  if (value.minutes !== 15) throw new Error("minimum action minutes must be 15");
  if (!String(value.action || "").trim()) throw new Error("minimum action is empty");
}
