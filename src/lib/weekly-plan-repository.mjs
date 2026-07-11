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

async function syncDirectory(fileSystem, directoryPath) {
  const handle = await fileSystem.open(directoryPath, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function publishExclusive(fileSystem, filePath, content, beforeLink) {
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await fileSystem.open(temporaryPath, "wx");
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await beforeLink?.({ temporaryPath });
    await fileSystem.link(temporaryPath, filePath);
    await syncDirectory(fileSystem, path.dirname(filePath));
  } finally {
    await handle?.close();
    await fileSystem.rm(temporaryPath, { force: true });
    await syncDirectory(fileSystem, path.dirname(filePath));
  }
}

function sameApprovedPlan(confirmed, draft) {
  return confirmed.status === "confirmed"
    && Boolean(confirmed.confirmedAt)
    && !Number.isNaN(Date.parse(confirmed.confirmedAt))
    && confirmed.weekId === draft.weekId
    && confirmed.version === draft.version
    && confirmed.createdAt === draft.createdAt
    && JSON.stringify(confirmed.outcomes) === JSON.stringify(draft.outcomes)
    && JSON.stringify(confirmed.deliverableChanges) === JSON.stringify(draft.deliverableChanges)
    && JSON.stringify(confirmed.tasks) === JSON.stringify(draft.tasks);
}

export function createWeeklyPlanRepository({
  kbDir,
  now = () => new Date().toISOString(),
  fileSystem = fs,
  beforeDraftVerification,
  afterApprovedDraftRead,
  beforeCanonicalLink,
}) {
  const weeklyDir = path.join(kbDir, "周计划");
  const canonicalFor = (weekId) => path.join(weeklyDir, `${weekId}.md`);
  const draftFor = (weekId, version) => path.join(weeklyDir, `${weekId}.v${version}.draft.md`);

  async function read(weekId, version) {
    if (version !== undefined) {
      const filePath = draftFor(weekId, version);
      return parse(await fs.readFile(filePath, "utf8"), filePath);
    }
    const canonicalPath = canonicalFor(weekId);
    try {
      return parse(await fs.readFile(canonicalPath, "utf8"), canonicalPath);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const prefix = `${weekId}.v`;
    const drafts = (await fs.readdir(weeklyDir)).filter((name) => name.startsWith(prefix) && name.endsWith(".draft.md"));
    if (drafts.length === 0) throw new Error(`weekly plan not found: ${weekId}`);
    const versions = drafts.map((name) => Number(name.slice(prefix.length, -".draft.md".length))).filter(Number.isInteger);
    return read(weekId, Math.max(...versions));
  }

  async function writeDraft({ weekId, version, plan }) {
    await fs.mkdir(weeklyDir, { recursive: true });
    const input = {
      weekId, version, status: "draft", createdAt: now(), confirmedAt: null,
      outcomes: plan.outcomes, deliverableChanges: plan.deliverableChanges, tasks: plan.tasks,
    };
    const filePath = draftFor(weekId, version);
    const content = render(input);
    try {
      await publishExclusive(fileSystem, filePath, content);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const existing = await fs.readFile(filePath, "utf8");
      if (existing !== content) throw new Error("weekly plan draft version is immutable", { cause: error });
    }
    return read(weekId, version);
  }

  async function confirm({ weekId, version, expectedHash }) {
    const draftPath = draftFor(weekId, version);
    await beforeDraftVerification?.({ draftPath });
    const draftContent = await fs.readFile(draftPath, "utf8");
    if (hash(draftContent) !== expectedHash) {
      throw new Error("weekly plan changed since read");
    }
    const draft = parse(draftContent, draftPath);
    if (draft.status !== "draft") throw new Error("weekly plan is not a draft");
    const content = render({ ...draft, status: "confirmed", confirmedAt: now() });
    const canonicalPath = canonicalFor(weekId);
    await afterApprovedDraftRead?.({ draftPath, canonicalPath });
    try {
      await publishExclusive(fileSystem, canonicalPath, content, ({ temporaryPath }) =>
        beforeCanonicalLink?.({ draftPath, canonicalPath, temporaryPath }));
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      try {
        const existing = parse(await fs.readFile(canonicalPath, "utf8"), canonicalPath);
        if (sameApprovedPlan(existing, draft)) return existing;
      } catch (readError) {
        throw new Error("confirmed weekly plan is immutable", { cause: readError });
      }
      throw new Error("confirmed weekly plan is immutable", { cause: error });
    }
    return read(weekId);
  }

  return { writeDraft, read, confirm };
}
