import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

const STATUSES = new Set(["draft", "confirmed"]);
const TASK_FIELDS = [
  "taskId", "projectId", "projectName", "milestoneId", "deliverableId", "title",
  "deliverable", "completionStandard", "minutes", "date", "requiresEvidence", "impact",
];
const TASK_HEADERS = [
  "task_id", "project_id", "project_name", "milestone_id", "deliverable_id", "title",
  "deliverable", "completion_standard", "minutes", "date", "requires_evidence", "impact",
];

function hash(content) {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function cell(value) {
  return String(value ?? "").replaceAll("\\", "\\\\").replaceAll("|", "\\|").replaceAll("\n", "<br>");
}

function uncell(value) {
  return value.replaceAll("<br>", "\n").replaceAll("\\|", "|").replaceAll("\\\\", "\\");
}

function splitRow(line) {
  const values = [];
  let current = "";
  for (let index = 1; index < line.length - 1; index += 1) {
    const char = line[index];
    if (char === "|" && line[index - 1] !== "\\") {
      values.push(uncell(current.trim()));
      current = "";
    } else current += char;
  }
  values.push(uncell(current.trim()));
  return values;
}

function render({ weekId, version, status, createdAt, confirmedAt, outcomes, deliverableChanges, tasks }) {
  const rows = tasks.map((task) => `| ${TASK_FIELDS.map((field) => cell(task[field])).join(" | ")} |`).join("\n");
  return `---
week_id: ${weekId}
version: ${version}
status: ${status}
created_at: ${createdAt}
confirmed_at: ${confirmedAt ?? ""}
---

# 周计划 ${weekId}

## 本周成果

\`\`\`json
${JSON.stringify(outcomes, null, 2)}
\`\`\`

## 交付项变更

\`\`\`json
${JSON.stringify(deliverableChanges, null, 2)}
\`\`\`

## 任务

| ${TASK_HEADERS.join(" | ")} |
| ${TASK_FIELDS.map(() => "---").join(" | ")} |
${rows}
`;
}

function parseJsonSection(raw, heading) {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = raw.match(new RegExp(`## ${escaped}\\r?\\n\\r?\\n\`\`\`json\\r?\\n([\\s\\S]*?)\\r?\\n\`\`\``));
  if (!match) throw new Error(`missing weekly plan section: ${heading}`);
  return JSON.parse(match[1]);
}

function parse(rawContent, filePath) {
  const frontmatter = rawContent.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!frontmatter) throw new Error("weekly plan frontmatter is missing");
  const values = Object.fromEntries(frontmatter[1].split(/\r?\n/).map((line) => {
    const index = line.indexOf(":");
    if (index < 0) throw new Error(`invalid weekly plan frontmatter: ${line}`);
    return [line.slice(0, index), line.slice(index + 1).trim()];
  }));
  for (const key of ["week_id", "version", "status", "created_at", "confirmed_at"]) {
    if (!(key in values)) throw new Error(`missing weekly plan field: ${key}`);
  }
  const version = Number(values.version);
  if (!Number.isInteger(version) || version < 1) throw new Error("invalid weekly plan version");
  if (!STATUSES.has(values.status)) throw new Error("invalid weekly plan status");
  const taskMatch = rawContent.match(/## 任务\r?\n\r?\n([\s\S]*)$/);
  if (!taskMatch) throw new Error("missing weekly plan section: 任务");
  const taskBlock = taskMatch[1];
  const lines = taskBlock.split(/\r?\n/).filter((line) => line.startsWith("|"));
  if (lines.length < 2 || splitRow(lines[0]).join() !== TASK_HEADERS.join()) throw new Error("invalid weekly task table");
  const tasks = lines.slice(2).map((line) => {
    const row = splitRow(line);
    if (row.length !== TASK_FIELDS.length) throw new Error("invalid weekly task row");
    const task = Object.fromEntries(TASK_FIELDS.map((field, index) => [field, row[index]]));
    task.minutes = Number(task.minutes);
    task.requiresEvidence = task.requiresEvidence === "true";
    return task;
  });
  return {
    weekId: values.week_id, version, status: values.status, createdAt: values.created_at,
    confirmedAt: values.confirmed_at || null, outcomes: parseJsonSection(rawContent, "本周成果"),
    deliverableChanges: parseJsonSection(rawContent, "交付项变更"), tasks,
    contentHash: hash(rawContent), rawContent, filePath,
  };
}

async function atomicWrite(filePath, content) {
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporaryPath, content, "utf8");
    await fs.rename(temporaryPath, filePath);
  } finally {
    await fs.rm(temporaryPath, { force: true });
  }
}

async function atomicCompareReplace(filePath, content, expectedHash, afterClaim) {
  const suffix = `${process.pid}.${randomUUID()}`;
  const temporaryPath = `${filePath}.${suffix}.tmp`;
  const backupPath = `${filePath}.${suffix}.bak`;
  let claimed = false;
  try {
    await fs.writeFile(temporaryPath, content, { encoding: "utf8", flag: "wx" });
    await fs.rename(filePath, backupPath);
    claimed = true;
    await afterClaim?.({ filePath, backupPath, temporaryPath });
    const claimedContent = await fs.readFile(backupPath, "utf8");
    if (hash(claimedContent) !== expectedHash) throw new Error("weekly plan changed since read");
    try {
      await fs.link(temporaryPath, filePath);
    } catch (error) {
      if (error.code === "EEXIST") throw new Error("weekly plan changed during confirmation", { cause: error });
      throw error;
    }
    await fs.rm(temporaryPath, { force: true });
    await fs.rm(backupPath, { force: true });
    claimed = false;
  } catch (error) {
    if (claimed) {
      try {
        await fs.link(backupPath, filePath);
      } catch (restoreError) {
        if (restoreError.code !== "EEXIST") throw new AggregateError([error, restoreError], "weekly plan restore failed");
      }
    }
    throw error;
  } finally {
    await fs.rm(temporaryPath, { force: true });
    await fs.rm(backupPath, { force: true });
  }
}

export function createWeeklyPlanRepository({
  kbDir,
  now = () => new Date().toISOString(),
  beforeConfirmClaim,
  afterConfirmClaim,
}) {
  const weeklyDir = path.join(kbDir, "周计划");
  const fileFor = (weekId) => path.join(weeklyDir, `${weekId}.md`);

  async function read(weekId) {
    return parse(await fs.readFile(fileFor(weekId), "utf8"), fileFor(weekId));
  }

  async function writePlan(input) {
    await fs.mkdir(weeklyDir, { recursive: true });
    const filePath = fileFor(input.weekId);
    await atomicWrite(filePath, render(input));
    return read(input.weekId);
  }

  async function writeDraft({ weekId, version, plan }) {
    return writePlan({
      weekId, version, status: "draft", createdAt: now(), confirmedAt: null,
      outcomes: plan.outcomes, deliverableChanges: plan.deliverableChanges, tasks: plan.tasks,
    });
  }

  async function confirm({ weekId, version, expectedHash }) {
    const current = await read(weekId);
    if (current.version !== version || current.contentHash !== expectedHash) {
      throw new Error("weekly plan changed since read");
    }
    const content = render({ ...current, status: "confirmed", confirmedAt: now() });
    await beforeConfirmClaim?.({ filePath: current.filePath });
    await atomicCompareReplace(current.filePath, content, expectedHash, afterConfirmClaim);
    return read(weekId);
  }

  return { writeDraft, read, confirm };
}
