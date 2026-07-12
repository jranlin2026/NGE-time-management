import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const TASK_SCHEMA = fileURLToPath(new URL("./codex-task-schema.json", import.meta.url));
const MINIMUM_ACTION_SCHEMA = fileURLToPath(
  new URL("./codex-minimum-action-schema.json", import.meta.url),
);
const WEEKLY_PLAN_SCHEMA = fileURLToPath(new URL("./codex-weekly-plan-schema.json", import.meta.url));
const ACCEPTANCE_SCHEMA = fileURLToPath(new URL("./codex-acceptance-schema.json", import.meta.url));
const CHECKPOINT_SCHEMA = fileURLToPath(new URL("./codex-checkpoint-schema.json", import.meta.url));

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

    async analyzeAcceptance({ task, evidence }) {
      const text = await run({
        mode: "acceptance",
        schemaPath: ACCEPTANCE_SCHEMA,
        prompt: [
          "判断证据是否满足任务完成标准。只能输出 accepted、rejected 或 needs_user_confirmation。",
          `任务：${JSON.stringify(task)}`,
          `证据：${JSON.stringify(evidence)}`,
          "证据不可访问、含糊或无法可靠判断时，必须 needs_user_confirmation。",
        ].join("\n"),
      });
      const parsed = JSON.parse(text);
      if (!["accepted", "rejected", "needs_user_confirmation"].includes(parsed?.status)) {
        throw new Error("invalid acceptance status");
      }
      if (typeof parsed.explanation !== "string") throw new Error("acceptance explanation is required");
      return parsed;
    },

    async analyzeWeeklyPlan({ weekId, projects, previousPlan = null }) {
      try {
        const text = await run({
          mode: "weekly_plan",
          schemaPath: WEEKLY_PLAN_SCHEMA,
          prompt: buildWeeklyPrompt({ weekId, projects, previousPlan }),
        });
        const parsed = JSON.parse(text);
        validateWeeklyPlan(parsed, projects);
        return { ...parsed, analysisStatus: "complete" };
      } catch (error) {
        return fallbackWeeklyPlan({ weekId, projects, error });
      }
    },

    async analyzeCheckpointMessages({ node, workDate, messages = [], context = {} }) {
      try {
        const text = await run({
          mode: "checkpoint_messages",
          schemaPath: CHECKPOINT_SCHEMA,
          prompt: buildCheckpointPrompt({ node, workDate, messages, context }),
        });
        const parsed = JSON.parse(text);
        validateCheckpointAnalysis(parsed, messages);
        return { ...parsed, analysisStatus: "complete" };
      } catch (error) {
        return fallbackCheckpointAnalysis(messages, error);
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
      "--model",
      config.codexModel || "gpt-5.3-codex-spark",
      "-c",
      `model_reasoning_effort=${JSON.stringify(config.codexReasoningEffort || "low")}`,
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

function buildWeeklyPrompt({ weekId, projects, previousPlan }) {
  return [
    "你是个人项目系统中的周计划分析器。只返回 JSON Schema 要求的计划，不修改文件或发送消息。",
    "每个任务必须绑定项目中现有的待完成交付项，或绑定本计划 deliverableChanges 中同项目、同里程碑新增的交付项。",
    "任务必须包含可观察的交付物和完成标准；绑定交付项时 requiresEvidence 必须为 true。",
    "不要扩大范围。impact 只能是 normal；只有明确影响极享OS系统使用的 Bug 才可标记 system_unusable_bug。",
    `计划周：${weekId}`,
    `项目事实：${JSON.stringify(projects)}`,
    `上一版计划：${JSON.stringify(previousPlan)}`,
  ].join("\n");
}

function buildCheckpointPrompt({ node, workDate, messages, context }) {
  return [
    "Classify one fixed-checkpoint batch. Do not execute actions or claim scheduling.",
    "Interrupt only for an unusable Jixiang OS bug, explicit current business loss,",
    "a real owner-only deadline, or a blocker affecting multiple people.",
    "Personal IP is otherwise default priority. Ideas without deadlines enter candidate_pool.",
    "Never invent deadlines, losses, customers, owners, evidence, or attachment contents.",
    "Each executable task needs 1-8 concrete 15-45 minute checkpoints.",
    `Checkpoint node: ${JSON.stringify(node)}`,
    `Work date: ${JSON.stringify(workDate)}`,
    `Messages: ${JSON.stringify(messages)}`,
    `Context: ${JSON.stringify(context)}`,
  ].join("\n");
}

const CHECKPOINT_CATEGORIES = new Set([
  "task", "idea", "system_bug", "meeting", "blocker", "defer_reason", "evidence", "communication",
]);
const CHECKPOINT_DISPOSITIONS = new Set([
  "interrupt_now", "schedule_today", "candidate_pool", "do_not_schedule",
  "task_feedback", "evidence_submission", "no_action",
]);
const CHECKPOINT_ITEM_FIELDS = [
  "messageIds", "category", "disposition", "title", "projectId", "urgency", "mustBeOwner",
  "estimateMinutes", "dueAt", "nextAction", "doneDefinition", "checkpoints", "rationale",
];

function validateCheckpointAnalysis(value, messages) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid checkpoint analysis");
  if (Object.keys(value).some((field) => !["items", "combinedReplyContext"].includes(field))) {
    throw new Error("unsupported checkpoint analysis field");
  }
  if (!Array.isArray(value.items)) throw new Error("missing checkpoint items");
  if (typeof value.combinedReplyContext !== "string") throw new Error("missing combinedReplyContext");
  const knownMessageIds = new Set(messages.map((message) => message?.messageId).filter(Boolean));
  const classifiedMessageIds = new Set();
  for (const item of value.items) {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("invalid checkpoint item");
    if (Object.keys(item).some((field) => !CHECKPOINT_ITEM_FIELDS.includes(field))) throw new Error("unsupported checkpoint item field");
    for (const field of CHECKPOINT_ITEM_FIELDS) {
      if (!(field in item)) throw new Error(`missing checkpoint item field: ${field}`);
    }
    if (!Array.isArray(item.messageIds) || item.messageIds.length < 1
      || item.messageIds.some((id) => typeof id !== "string" || !id || !knownMessageIds.has(id))) {
      throw new Error("invalid checkpoint messageIds");
    }
    for (const id of item.messageIds) {
      if (classifiedMessageIds.has(id)) throw new Error("duplicate checkpoint messageId");
      classifiedMessageIds.add(id);
    }
    if (!CHECKPOINT_CATEGORIES.has(item.category)) throw new Error("invalid checkpoint category");
    if (!CHECKPOINT_DISPOSITIONS.has(item.disposition)) throw new Error("invalid checkpoint disposition");
    if (![item.title, item.nextAction, item.doneDefinition, item.rationale].every((entry) => typeof entry === "string" && entry.trim())) {
      throw new Error("invalid checkpoint item text");
    }
    if (item.projectId !== null && (typeof item.projectId !== "string" || !item.projectId.trim())) throw new Error("invalid checkpoint projectId");
    if (!URGENCY.has(item.urgency)) throw new Error("invalid checkpoint urgency");
    if (typeof item.mustBeOwner !== "boolean") throw new Error("invalid checkpoint mustBeOwner");
    if (!Number.isInteger(item.estimateMinutes) || item.estimateMinutes < 1) throw new Error("invalid checkpoint estimateMinutes");
    if (item.dueAt !== null && (typeof item.dueAt !== "string" || Number.isNaN(Date.parse(item.dueAt)))) throw new Error("invalid checkpoint dueAt");
    if (!Array.isArray(item.checkpoints) || item.checkpoints.length < 1 || item.checkpoints.length > 8
      || item.checkpoints.some((entry) => typeof entry !== "string" || !entry.trim())) {
      throw new Error("invalid checkpoint checkpoints");
    }
  }
  if (classifiedMessageIds.size !== knownMessageIds.size) throw new Error("missing checkpoint message classification");
}

function fallbackCheckpointAnalysis(messages, error) {
  return {
    items: messages.map((message) => ({
      messageIds: [String(message?.messageId || "unknown")],
      category: "communication",
      disposition: "candidate_pool",
      title: "待人工复核的消息",
      projectId: null,
      urgency: "low",
      mustBeOwner: false,
      estimateMinutes: 15,
      dueAt: null,
      nextAction: "人工阅读原始消息并判断下一步",
      doneDefinition: "完成分类并记录明确处理决定",
      checkpoints: ["人工复核原始消息"],
      rationale: "自动分析无效或不受支持，保守进入候选池，不打断也不排期",
    })),
    combinedReplyContext: "消息分析失败，已保守放入候选池等待人工复核",
    analysisStatus: "failed",
    analysisError: String(error?.message || error).slice(0, 500),
  };
}

const WEEKLY_TASK_FIELDS = [
  "taskId", "projectId", "projectName", "milestoneId", "deliverableId", "title",
  "deliverable", "completionStandard", "minutes", "date", "requiresEvidence", "impact",
];

function isValidDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

export function validateWeeklyPlan(value, projects) {
  if (!value || typeof value !== "object") throw new Error("weekly plan must be an object");
  if (!Array.isArray(value.outcomes) || !value.outcomes.every((item) => String(item).trim())) {
    throw new Error("invalid weekly outcomes");
  }
  if (!Array.isArray(value.deliverableChanges) || !Array.isArray(value.tasks)) {
    throw new Error("weekly plan arrays are missing");
  }
  const changeIds = new Set();
  for (const change of value.deliverableChanges) {
    const project = projects.find((item) => item.id === change.projectId);
    if (!project) throw new Error(`unknown deliverable change project: ${change.projectId}`);
    const milestone = project.milestones?.find((item) => item.id === change.milestoneId);
    if (!milestone) throw new Error(`unknown deliverable change milestone: ${change.milestoneId}`);
    const current = milestone.deliverables?.find((item) => item.id === change.deliverableId);
    const existing = Boolean(current);
    const changeId = `${change.projectId}\0${change.milestoneId}\0${change.deliverableId}`;
    if (!String(change.deliverableId).trim() || changeIds.has(changeId)) {
      throw new Error(`invalid deliverable change id: ${change.deliverableId}`);
    }
    changeIds.add(changeId);
    if (current?.status === "accepted") {
      throw new Error(`weekly plan cannot change accepted deliverable: ${change.deliverableId}`);
    }
    if (change.action === "add" && (change.status !== "pending" || ("evidence" in change && change.evidence !== ""))) {
      throw new Error("new deliverable must be pending with empty evidence");
    }
    if (change.status === "accepted" || ("evidence" in change && change.evidence !== "")) {
      throw new Error("weekly plan cannot set accepted status or evidence");
    }
    if (change.action !== "add" && !existing) {
      throw new Error(`unknown deliverable change deliverable: ${change.deliverableId}`);
    }
  }
  const proposed = new Set(value.deliverableChanges
    .filter((change) => change.action === "add")
    .map((change) => `${change.projectId}\0${change.milestoneId}\0${change.deliverableId}`));
  const taskIds = new Set();
  for (const task of value.tasks) {
    for (const field of WEEKLY_TASK_FIELDS) {
      if (!(field in task)) throw new Error(`missing weekly task field: ${field}`);
    }
    if (!String(task.taskId).trim() || taskIds.has(task.taskId)) throw new Error(`invalid weekly task id: ${task.taskId}`);
    taskIds.add(task.taskId);
    const project = projects.find((item) => item.id === task.projectId);
    if (!project || project.name !== task.projectName) throw new Error(`unknown weekly task project: ${task.projectId}`);
    const milestone = project.milestones?.find((item) => item.id === task.milestoneId);
    if (!milestone) throw new Error(`unknown weekly task milestone: ${task.milestoneId}`);
    const deliverable = milestone.deliverables?.find((item) => item.id === task.deliverableId);
    const proposedKey = `${task.projectId}\0${task.milestoneId}\0${task.deliverableId}`;
    if (!deliverable && !proposed.has(proposedKey)) throw new Error(`unknown weekly task deliverable: ${task.deliverableId}`);
    if (!["pending", "doing", "blocked"].includes(deliverable?.status) && !proposed.has(proposedKey)) {
      throw new Error(`weekly task deliverable is already accepted: ${task.deliverableId}`);
    }
    if (![task.title, task.deliverable, task.completionStandard, task.date].every((item) => String(item).trim())) {
      throw new Error(`invalid weekly task text: ${task.taskId}`);
    }
    if (!Number.isInteger(task.minutes) || task.minutes < 5 || task.minutes > 480) throw new Error("invalid weekly task minutes");
    if (!isValidDate(task.date)) {
      throw new Error("invalid weekly task date");
    }
    if (typeof task.requiresEvidence !== "boolean" || !task.requiresEvidence) throw new Error("project task requires evidence");
    if (!new Set(["normal", "system_unusable_bug"]).has(task.impact)) throw new Error("invalid weekly task impact");
  }
}

function mondayOfIsoWeek(weekId) {
  const match = /^(\d{4})-W(\d{2})$/.exec(weekId);
  if (!match) return "";
  const januaryFourth = new Date(Date.UTC(Number(match[1]), 0, 4));
  const monday = new Date(januaryFourth);
  monday.setUTCDate(januaryFourth.getUTCDate() - ((januaryFourth.getUTCDay() + 6) % 7) + (Number(match[2]) - 1) * 7);
  return monday.toISOString().slice(0, 10);
}

export function fallbackWeeklyPlan({ weekId, projects, error }) {
  const date = mondayOfIsoWeek(weekId);
  const pending = projects.flatMap((project) => (project.milestones ?? []).flatMap((milestone) =>
    (milestone.deliverables ?? [])
      .filter((deliverable) => deliverable.status === "pending")
      .map((deliverable) => ({ project, milestone, deliverable }))));
  return {
    outcomes: pending.map(({ deliverable }) => deliverable.name),
    deliverableChanges: [],
    tasks: pending.map(({ project, milestone, deliverable }) => ({
      taskId: `${weekId}:${project.id}:${milestone.id}:${deliverable.id}`,
      projectId: project.id, projectName: project.name,
      milestoneId: milestone.id, deliverableId: deliverable.id, title: deliverable.name,
      deliverable: deliverable.name, completionStandard: deliverable.evidence || `提交可验收的${deliverable.name}`,
      minutes: 120, date, requiresEvidence: true, impact: "normal",
    })),
    analysisStatus: "failed",
    analysisError: String(error?.message || error).slice(0, 500),
  };
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
