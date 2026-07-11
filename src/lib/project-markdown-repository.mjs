import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

const START = "<!-- time-manager:managed:start -->";
const END = "<!-- time-manager:managed:end -->";
const PROJECT_STATUSES = new Set(["draft", "active", "paused", "completed", "archived"]);
const MILESTONE_STATUSES = new Set(["pending", "active", "completed", "paused", "blocked"]);
const DELIVERABLE_STATUSES = new Set(["pending", "doing", "accepted", "blocked"]);

export class ProjectFormatError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "ProjectFormatError";
  }
}

export class ProjectReconciliationConflictError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "ProjectReconciliationConflictError";
    this.code = "PROJECT_RECONCILIATION_CONFLICT";
    this.recoverable = true;
    this.details = details;
  }
}

function fail(message) {
  throw new ProjectFormatError(message);
}

function hash(content) {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function parseFrontmatter(raw) {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) fail("project frontmatter is missing or malformed");
  const values = {};
  for (const line of match[1].split(/\r?\n/)) {
    const field = line.match(/^([a-z_]+):\s*(.*)$/);
    if (!field) fail(`invalid frontmatter line: ${line}`);
    values[field[1]] = field[2].trim();
  }
  for (const key of ["project_id", "name", "status", "priority", "updated_at"]) {
    if (!values[key]) fail(`missing frontmatter field: ${key}`);
  }
  if (!PROJECT_STATUSES.has(values.status)) fail(`invalid project status: ${values.status}`);
  const priority = Number(values.priority);
  if (!Number.isFinite(priority)) fail("project priority must be numeric");
  return { values, priority, full: match[0], bodyOffset: match[0].length };
}

function managedBounds(raw) {
  const starts = raw.split(START).length - 1;
  const ends = raw.split(END).length - 1;
  if (starts !== 1 || ends !== 1) fail("project must contain exactly one managed marker pair");
  const start = raw.indexOf(START);
  const end = raw.indexOf(END);
  if (end < start) fail("managed section markers are out of order");
  return { start, end: end + END.length, content: raw.slice(start, end + END.length) };
}

function tableBelow(section, heading) {
  const headingIndex = section.indexOf(`## ${heading}`);
  if (headingIndex < 0) fail(`missing managed heading: ${heading}`);
  const tail = section.slice(headingIndex + heading.length + 3);
  const nextHeading = tail.search(/\n## /);
  const block = nextHeading < 0 ? tail : tail.slice(0, nextHeading);
  const lines = block.split(/\r?\n/).filter((line) => line.trim().startsWith("|"));
  if (lines.length < 3) fail(`missing ${heading} table rows`);
  return lines.slice(2).map((line) => line.trim().slice(1, -1).split("|").map((cell) => cell.trim()));
}

function sectionText(section, heading) {
  const match = section.match(new RegExp(`## ${heading}\\r?\\n\\r?\\n([\\s\\S]*?)(?=\\r?\\n## |\\r?\\n${END.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`));
  return match?.[1].trim() ?? "";
}

function parseProject(rawContent, filePath) {
  const frontmatter = parseFrontmatter(rawContent);
  const bounds = managedBounds(rawContent);
  const milestoneRows = tableBelow(bounds.content, "里程碑");
  const deliverableRows = tableBelow(bounds.content, "里程碑交付项");
  const milestoneIds = new Set();
  const deliverableIds = new Set();
  const milestones = milestoneRows.map((row) => {
    if (row.length !== 5 || !row[0]) fail("invalid milestone row");
    if (milestoneIds.has(row[0])) fail(`duplicate milestone id: ${row[0]}`);
    milestoneIds.add(row[0]);
    const weight = Number(row[3]);
    if (!Number.isFinite(weight) || weight < 0 || weight > 100) fail(`invalid milestone weight: ${row[3]}`);
    if (!MILESTONE_STATUSES.has(row[4])) fail(`invalid milestone status: ${row[4]}`);
    return { id: row[0], name: row[1], dueDate: row[2], weight, status: row[4], deliverables: [] };
  });
  for (const row of deliverableRows) {
    if (row.length !== 6 || !row[0]) fail("invalid deliverable row");
    if (deliverableIds.has(row[0])) fail(`duplicate deliverable id: ${row[0]}`);
    deliverableIds.add(row[0]);
    const milestone = milestones.find((item) => item.id === row[1]);
    if (!milestone) fail(`unknown milestone id for deliverable ${row[0]}: ${row[1]}`);
    const weight = Number(row[3]);
    if (!Number.isFinite(weight) || weight < 0 || weight > 100) fail(`invalid deliverable weight: ${row[3]}`);
    if (!DELIVERABLE_STATUSES.has(row[4])) fail(`invalid deliverable status: ${row[4]}`);
    milestone.deliverables.push({ id: row[0], milestoneId: row[1], name: row[2], weight, status: row[4], evidence: row[5] });
  }
  if (milestones.reduce((sum, item) => sum + item.weight, 0) !== 100) fail("milestone weights must total 100");
  for (const milestone of milestones) {
    if (milestone.deliverables.reduce((sum, item) => sum + item.weight, 0) !== 100) {
      fail(`deliverable weights for milestone ${milestone.id} must total 100`);
    }
  }
  const parsed = {
    id: frontmatter.values.project_id,
    name: frontmatter.values.name,
    status: frontmatter.values.status,
    priority: frontmatter.priority,
    updatedAt: frontmatter.values.updated_at,
    currentStage: sectionText(bounds.content, "当前阶段"),
    risks: sectionText(bounds.content, "当前风险"),
    nextCandidates: sectionText(bounds.content, "下一步候选"),
    latestResult: sectionText(bounds.content, "最近一次实质成果"),
    milestones,
    contentHash: hash(rawContent),
    rawContent,
    filePath,
  };
  parsed.progress = computeProjectProgress(parsed);
  return parsed;
}

export function computeProjectProgress(project) {
  return Math.round(project.milestones.reduce((total, milestone) => {
    const progress = milestone.deliverables
      .filter((item) => item.status === "accepted")
      .reduce((sum, item) => sum + item.weight, 0);
    return total + progress * milestone.weight / 100;
  }, 0) * 100) / 100;
}

function renderManaged(project) {
  const milestoneRows = project.milestones.map((item) =>
    `| ${item.id} | ${item.name} | ${item.dueDate} | ${item.weight} | ${item.status} |`).join("\n");
  const deliverableRows = project.milestones.flatMap((milestone) => milestone.deliverables.map((item) =>
    `| ${item.id} | ${milestone.id} | ${item.name} | ${item.weight} | ${item.status} | ${item.evidence ?? ""} |`)).join("\n");
  return `${START}
## 当前阶段

${project.currentStage || "待确认"}

## 里程碑

| milestone_id | 名称 | 截止时间 | 项目权重 | 状态 |
| --- | --- | --- | ---: | --- |
${milestoneRows}

## 里程碑交付项

| deliverable_id | milestone_id | 交付项 | 里程碑权重 | 状态 | 验收证据 |
| --- | --- | --- | ---: | --- | --- |
${deliverableRows}

## 当前风险

${project.risks || "-暂无。"}

## 下一步候选

${project.nextCandidates || "-待确认。"}

## 最近一次实质成果

${project.latestResult || "尚无。"}
${END}`;
}

function replaceManagedRegion(raw, managed) {
  const bounds = managedBounds(raw);
  return raw.slice(0, bounds.start) + managed + raw.slice(bounds.end);
}

async function atomicWrite(filePath, content) {
  const temp = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const handle = await fs.open(temp, "wx");
    try {
      await handle.writeFile(content, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temp, filePath);
    await syncDirectory(path.dirname(filePath));
  } finally {
    await fs.rm(temp, { force: true });
  }
}

async function syncDirectory(dirPath) {
  const handle = await fs.open(dirPath, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeImmutableReceipt(filePath, receipt) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await syncDirectory(path.dirname(path.dirname(filePath)));
  const temp = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await fs.open(temp, "wx");
  try {
    await handle.writeFile(`${JSON.stringify(receipt, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.link(temp, filePath);
    await syncDirectory(path.dirname(filePath));
  } finally {
    await fs.rm(temp, { force: true });
    await syncDirectory(path.dirname(filePath));
  }
}

function safeTimestamp(value) {
  return value.replace(/:/g, "-");
}

function findProjectDeliverable(project, deliverableId) {
  return project.milestones.flatMap((item) => item.deliverables).find((item) => item.id === deliverableId);
}

function deliverableContribution(project, deliverable) {
  const milestone = project.milestones.find((item) => item.id === deliverable.milestoneId);
  return Number(milestone?.weight || 0) * Number(deliverable.weight || 0) / 100;
}

function roundProgress(value) {
  return Math.round(value * 100) / 100;
}

export function createProjectMarkdownRepository(deps) {
  const { kbDir, now = () => new Date().toISOString(), id = randomUUID } = deps;
  const projectDir = path.join(kbDir, "项目");
  const fail = deps.failureInjector || (() => {});

  async function projectFiles() {
    try {
      return (await fs.readdir(projectDir, { withFileTypes: true }))
        .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
        .map((entry) => path.join(projectDir, entry.name)).sort();
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
  }

  async function readFile(filePath) {
    return parseProject(await fs.readFile(filePath, "utf8"), filePath);
  }

  async function listProjects() {
    return Promise.all((await projectFiles()).map(readFile));
  }

  async function readProject(projectId) {
    const matches = (await listProjects()).filter((project) => project.id === projectId);
    if (matches.length === 0) throw new Error(`project not found: ${projectId}`);
    if (matches.length > 1) fail(`duplicate project id: ${projectId}`);
    return matches[0];
  }

  async function ensureDraftTemplates(projectSpecs) {
    await fs.mkdir(projectDir, { recursive: true });
    const created = [];
    for (const spec of projectSpecs) {
      const filePath = path.join(projectDir, `${spec.name}.md`);
      try {
        await fs.access(filePath);
        continue;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      const project = {
        id: spec.projectId, name: spec.name, status: "draft", priority: spec.priority ?? 1,
        currentStage: spec.currentStage ?? "待确认", risks: spec.risks ?? "-暂无。",
        nextCandidates: spec.nextCandidates ?? `- ${spec.deliverableName}`, latestResult: "尚无。",
        milestones: [{
          id: spec.milestoneId, name: spec.milestoneName, dueDate: spec.dueDate ?? "待定", weight: 100, status: "active",
          deliverables: [{ id: spec.deliverableId, name: spec.deliverableName, weight: 100, status: "pending", evidence: "" }],
        }],
      };
      const content = `---\nproject_id: ${project.id}\nname: ${project.name}\nstatus: draft\npriority: ${project.priority}\nupdated_at: ${now()}\n---\n\n# ${project.name}\n\n## 项目目标\n\n${spec.goal ?? "待确认。"}\n\n${renderManaged(project)}\n\n## 自由笔记\n\n`;
      await fs.writeFile(filePath, content, { encoding: "utf8", flag: "wx" });
      created.push(await readFile(filePath));
    }
    return { created, projects: await listProjects() };
  }

  async function confirmDraft(projectId, expectedHash) {
    const current = await readProject(projectId);
    if (current.contentHash !== expectedHash) throw new Error("project changed since read");
    if (current.status !== "draft") throw new Error("project is not a draft");
    const content = current.rawContent.replace(/^status:\s*draft$/m, "status: active");
    await atomicWrite(current.filePath, content);
    return readFile(current.filePath);
  }

  async function writeManagedChange(input, mutate) {
    if (input.operationKey) return writeReceiptManagedChange(input, mutate);
    const current = await readProject(input.projectId);
    if (current.contentHash !== input.expectedHash) throw new Error("project changed since read");
    const beforeProgress = computeProjectProgress(current);
    const updated = structuredClone(current);
    mutate(updated);
    // Rendering then parsing enforces IDs, statuses, and all weight totals before replacement.
    const nextContent = replaceManagedRegion(current.rawContent, renderManaged(updated));
    const validated = parseProject(nextContent, current.filePath);
    const afterProgress = computeProjectProgress(validated);
    await atomicWrite(current.filePath, nextContent);
    const timestamp = now();
    const logDir = path.join(kbDir, "项目变更记录");
    await fs.mkdir(logDir, { recursive: true });
    const logPath = path.join(logDir, `${safeTimestamp(timestamp)}-${input.projectId}-${id()}.md`);
    const evidence = input.evidence ?? "";
    const reason = input.reason ?? "deliverable accepted";
    await fs.writeFile(logPath, `# 项目变更记录\n\n- 项目: ${input.projectId}\n- 时间: ${timestamp}\n- 变更前进度: ${beforeProgress}\n- 变更后进度: ${afterProgress}\n- 验收证据: ${evidence}\n- 原因: ${reason}\n`, "utf8");
    return { ...(await readFile(current.filePath)), beforeProgress, projectProgress: afterProgress, changeLogPath: logPath };
  }

  async function writeReceiptManagedChange(input, mutate) {
    const safeKey = input.operationKey.replace(/[^a-zA-Z0-9._-]/g, "-");
    const receiptPath = path.join(kbDir, "项目变更记录", `${safeKey}.json`);
    const current = await readProject(input.projectId);
    let receipt = await readReceipt(receiptPath);
    if (receipt) return recoverFromReceipt({ receipt, receiptPath, current, input });

    const currentDeliverable = findProjectDeliverable(current, input.deliverableId);
    if (currentDeliverable?.status === "accepted" && currentDeliverable.evidence === (input.evidence ?? "")) {
      const afterProgress = computeProjectProgress(current);
      const beforeProgress = roundProgress(afterProgress - deliverableContribution(current, currentDeliverable));
      receipt = makeReceipt({
        input, current, afterContent: current.rawContent, afterHash: current.contentHash,
        beforeHash: null, beforeProgress, afterProgress, recovered: true,
      });
      fail("before_receipt_write");
      await writeImmutableReceipt(receiptPath, receipt);
      fail("after_receipt_write");
      return receiptResult(current, receipt, receiptPath);
    }

    if (current.contentHash !== input.expectedHash) throw new Error("project changed since read");
    const beforeProgress = computeProjectProgress(current);
    const updated = structuredClone(current);
    mutate(updated);
    const afterContent = replaceManagedRegion(current.rawContent, renderManaged(updated));
    const validated = parseProject(afterContent, current.filePath);
    const afterProgress = computeProjectProgress(validated);
    receipt = makeReceipt({
      input, current, afterContent, afterHash: hash(afterContent), beforeHash: current.contentHash,
      beforeProgress, afterProgress, recovered: false,
    });
    fail("before_receipt_write");
    await writeImmutableReceipt(receiptPath, receipt);
    fail("after_receipt_write");
    await atomicWrite(current.filePath, afterContent);
    fail("after_markdown_write");
    const written = await readFile(current.filePath);
    assertReceiptEffect(written, receipt);
    return receiptResult(written, receipt, receiptPath);
  }

  async function recoverFromReceipt({ receipt, receiptPath, current, input }) {
    validateReceipt(receipt, input);
    if (hash(receipt.afterContent) !== receipt.afterHash) throw new ProjectReconciliationConflictError("project reconciliation conflict: receipt content hash mismatch");
    if (current.contentHash === receipt.afterHash) {
      assertReceiptEffect(current, receipt);
      return receiptResult(current, receipt, receiptPath);
    }
    if (receipt.beforeHash && current.contentHash === receipt.beforeHash) {
      await atomicWrite(current.filePath, receipt.afterContent);
      fail("after_markdown_write");
      const written = await readFile(current.filePath);
      assertReceiptEffect(written, receipt);
      return receiptResult(written, receipt, receiptPath);
    }
    throw new ProjectReconciliationConflictError("project reconciliation conflict: current hash matches neither receipt boundary", {
      currentHash: current.contentHash, beforeHash: receipt.beforeHash, afterHash: receipt.afterHash,
    });
  }

  function makeReceipt({ input, current, afterContent, afterHash, beforeHash, beforeProgress, afterProgress, recovered }) {
    const timestamp = now();
    return {
      version: 1,
      operationKey: input.operationKey,
      projectId: input.projectId,
      deliverableId: input.deliverableId || null,
      beforeHash,
      afterHash,
      beforeProgress,
      afterProgress,
      mutation: input.reason ?? "deliverable accepted",
      evidence: input.evidence ?? "",
      intended: { status: input.deliverableId ? "accepted" : null, evidence: input.evidence ?? "" },
      afterContent,
      createdAt: timestamp,
      recovered,
      recoveredAt: recovered ? timestamp : null,
      projectFilePath: current.filePath,
    };
  }

  async function readReceipt(receiptPath) {
    try {
      return JSON.parse(await fs.readFile(receiptPath, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw new ProjectReconciliationConflictError(`project reconciliation conflict: invalid receipt: ${error.message}`);
    }
  }

  function validateReceipt(receipt, input) {
    if (receipt.operationKey !== input.operationKey || receipt.projectId !== input.projectId
      || receipt.deliverableId !== (input.deliverableId || null) || receipt.evidence !== (input.evidence ?? "")) {
      throw new ProjectReconciliationConflictError("project reconciliation conflict: receipt identity does not match request");
    }
  }

  function assertReceiptEffect(project, receipt) {
    if (!receipt.deliverableId) return;
    const deliverable = findProjectDeliverable(project, receipt.deliverableId);
    if (deliverable?.status !== receipt.intended.status || deliverable?.evidence !== receipt.intended.evidence) {
      throw new ProjectReconciliationConflictError("project reconciliation conflict: receipt effect is not present");
    }
  }

  function receiptResult(project, receipt, receiptPath) {
    return { ...project, beforeProgress: receipt.beforeProgress, projectProgress: receipt.afterProgress, changeLogPath: receiptPath, receipt };
  }

  async function acceptDeliverable(input) {
    return writeManagedChange(input, (project) => {
      const deliverable = project.milestones.flatMap((item) => item.deliverables)
        .find((item) => item.id === input.deliverableId);
      if (!deliverable) throw new Error(`deliverable not found: ${input.deliverableId}`);
      deliverable.status = "accepted";
      deliverable.evidence = input.evidence;
      project.latestResult = `${deliverable.name}\n\n验收证据：${input.evidence}`;
    });
  }

  async function applyDeliverableChanges(input) {
    return writeManagedChange({ ...input, reason: input.reason ?? "confirmed deliverable changes" }, (project) => {
      for (const change of input.changes ?? input.deliverableChanges ?? []) {
        const milestone = project.milestones.find((item) => item.id === change.milestoneId);
        if (!milestone) throw new Error(`milestone not found: ${change.milestoneId}`);
        const index = milestone.deliverables.findIndex((item) => item.id === (change.deliverableId ?? change.id));
        if (change.action === "remove") {
          if (index >= 0) milestone.deliverables.splice(index, 1);
        } else if (index >= 0) {
          milestone.deliverables[index] = { ...milestone.deliverables[index], ...change, id: milestone.deliverables[index].id, milestoneId: milestone.id };
        } else {
          milestone.deliverables.push({
            id: change.deliverableId ?? change.id, milestoneId: milestone.id, name: change.name,
            weight: change.weight, status: change.status ?? "pending", evidence: change.evidence ?? "",
          });
        }
      }
    });
  }

  return { listProjects, readProject, ensureDraftTemplates, confirmDraft, applyDeliverableChanges, acceptDeliverable };
}
