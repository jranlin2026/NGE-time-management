import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createProjectMarkdownRepository,
  computeProjectProgress,
  ProjectFormatError,
} from "../src/lib/project-markdown-repository.mjs";

const START = "<!-- time-manager:managed:start -->";
const END = "<!-- time-manager:managed:end -->";

let root;

test.beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "project-markdown-"));
});

test.afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function writeProject(
  kbDir,
  { milestoneWeight = 100, deliverableStatus = "pending", rawSuffix = "" } = {},
) {
  const projectDir = path.join(kbDir, "项目");
  await fs.mkdir(projectDir, { recursive: true });
  const content = `---
project_id: personal-ip
name: 个人IP
status: active
priority: 1
updated_at: 2026-07-12T08:00:00+08:00
---

# 个人IP

${START}
## 当前阶段

内容冷启动

## 里程碑

| milestone_id | 名称 | 截止时间 | 项目权重 | 状态 |
| --- | --- | --- | ---: | --- |
| content-validation | 验证内容方向 | 2026-07-31 | ${milestoneWeight} | active |

## 里程碑交付项

| deliverable_id | milestone_id | 交付项 | 里程碑权重 | 状态 | 验收证据 |
| --- | --- | --- | ---: | --- | --- |
| video-01 | content-validation | 发布第 1 条短视频 | 10 | ${deliverableStatus} | |
| video-02 | content-validation | 发布其他短视频 | 90 | pending | |

## 当前风险

- 文案反复修改。

## 下一步候选

- 完成脚本。

## 最近一次实质成果

尚无。
${END}

## 自由笔记

我的自由笔记
不要修改${rawSuffix}
`;
  const filePath = path.join(projectDir, "个人IP.md");
  await fs.writeFile(filePath, content, "utf8");
  return filePath;
}

async function mutateProject(transform) {
  const filePath = await writeProject(root);
  const content = await fs.readFile(filePath, "utf8");
  await fs.writeFile(filePath, transform(content), "utf8");
  return filePath;
}

function outsideManaged(content) {
  const start = content.indexOf(START);
  const end = content.indexOf(END) + END.length;
  return Buffer.from(content.slice(0, start) + content.slice(end), "utf8");
}

test("reads structured projects and computes accepted weighted progress", async () => {
  await writeProject(root, { deliverableStatus: "accepted" });
  const repo = createProjectMarkdownRepository({ kbDir: root });
  const project = await repo.readProject("personal-ip");
  assert.equal(project.milestones[0].deliverables[0].id, "video-01");
  assert.equal(computeProjectProgress(project), 10);
  assert.equal(project.status, "active");
  assert.match(project.contentHash, /^[a-f0-9]{64}$/);
});

test("weekly deliverable changes cannot alter accepted scope or create pre-accepted progress", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "project-repo-weekly-guard-"));
  await writeProject(root, { deliverableStatus: "accepted" });
  const repo = createProjectMarkdownRepository({ kbDir: root });
  const before = await repo.readProject("personal-ip");
  for (const change of [
    { action: "remove", deliverableId: "video-01" },
    { action: "update", deliverableId: "video-01", status: "doing", evidence: "forged" },
  ]) {
    await assert.rejects(repo.applyDeliverableChanges({
      projectId: "personal-ip", expectedHash: before.contentHash,
      changes: [{ ...change, milestoneId: "content-validation", name: "changed", weight: 50 }],
    }), /accepted deliverable/);
  }
  await assert.rejects(repo.applyDeliverableChanges({
    projectId: "personal-ip", expectedHash: before.contentHash,
    changes: [{ action: "add", deliverableId: "video-03", milestoneId: "content-validation", name: "new", weight: 10, status: "accepted", evidence: "forged" }],
  }), /new deliverable.*pending.*empty evidence/);
  await assert.rejects(repo.applyDeliverableChanges({
    projectId: "personal-ip", expectedHash: before.contentHash,
    changes: [{ action: "update", deliverableId: "video-02", milestoneId: "content-validation", name: "changed", weight: 90, status: "accepted", evidence: "forged" }],
  }), /cannot set accepted status or evidence/);
  const after = await repo.readProject("personal-ip");
  assert.equal(after.progress, before.progress);
  assert.equal(after.milestones[0].deliverables[0].status, "accepted");
});

test("rejects weights that do not total one hundred", async () => {
  await writeProject(root, { milestoneWeight: 90 });
  const repo = createProjectMarkdownRepository({ kbDir: root });
  await assert.rejects(() => repo.readProject("personal-ip"), ProjectFormatError);
});

test("rejects duplicate milestone and deliverable IDs", async () => {
  let filePath = await mutateProject((content) => content.replace(
    "| content-validation | 验证内容方向 | 2026-07-31 | 100 | active |",
    "| content-validation | 验证内容方向 | 2026-07-31 | 50 | active |\n| content-validation | 重复 | 2026-08-31 | 50 | pending |",
  ));
  await assert.rejects(() => createProjectMarkdownRepository({ kbDir: root }).readProject("personal-ip"), /duplicate milestone id/);
  await fs.rm(filePath);

  filePath = await mutateProject((content) => content.replace(
    "| video-02 | content-validation | 发布其他短视频 | 90 | pending | |",
    "| video-01 | content-validation | 发布其他短视频 | 90 | pending | |",
  ));
  await assert.rejects(() => createProjectMarkdownRepository({ kbDir: root }).readProject("personal-ip"), /duplicate deliverable id/);
});

test("rejects invalid project, milestone, and deliverable statuses", async () => {
  for (const [from, to, expected] of [
    ["status: active", "status: unknown", /invalid project status/],
    ["100 | active |", "100 | unknown |", /invalid milestone status/],
    ["10 | pending | |", "10 | unknown | |", /invalid deliverable status/],
  ]) {
    const filePath = await mutateProject((content) => content.replace(from, to));
    await assert.rejects(() => createProjectMarkdownRepository({ kbDir: root }).readProject("personal-ip"), expected);
    await fs.rm(filePath);
  }
});

test("rejects missing, duplicate, and misordered managed markers", async () => {
  for (const transform of [
    (content) => content.replace(START, ""),
    (content) => content.replace(START, `${START}\n${START}`),
    (content) => content.replace(START, "PLACEHOLDER").replace(END, START).replace("PLACEHOLDER", END),
  ]) {
    const filePath = await mutateProject(transform);
    await assert.rejects(() => createProjectMarkdownRepository({ kbDir: root }).readProject("personal-ip"), ProjectFormatError);
    await fs.rm(filePath);
  }
});

test("rejects deliverables that reference an unknown milestone", async () => {
  await mutateProject((content) => content.replace("| video-01 | content-validation |", "| video-01 | missing-milestone |"));
  await assert.rejects(() => createProjectMarkdownRepository({ kbDir: root }).readProject("personal-ip"), /unknown milestone id/);
});

test("rejects deliverable weights that do not total one hundred", async () => {
  await mutateProject((content) => content.replace(
    "| video-02 | content-validation | 发布其他短视频 | 90 |",
    "| video-02 | content-validation | 发布其他短视频 | 80 |",
  ));
  await assert.rejects(() => createProjectMarkdownRepository({ kbDir: root }).readProject("personal-ip"), /deliverable weights.*must total 100/);
});

test("lists valid project markdown files", async () => {
  await writeProject(root);
  const projects = await createProjectMarkdownRepository({ kbDir: root }).listProjects();
  assert.deepEqual(projects.map((project) => project.id), ["personal-ip"]);
});

test("ignores unrelated markdown files in the project knowledge folder", async () => {
  await writeProject(root);
  const unrelatedPath = path.join(root, "项目", "产品需求.md");
  const unrelated = `---\n类型: 产品需求\n状态: 已完成\n---\n\n# 普通知识文档\n\n这里不是自动管理项目。\n`;
  await fs.writeFile(unrelatedPath, unrelated, "utf8");

  const repo = createProjectMarkdownRepository({ kbDir: root });
  const projects = await repo.listProjects();

  assert.deepEqual(projects.map((project) => project.id), ["personal-ip"]);
  assert.equal(await fs.readFile(unrelatedPath, "utf8"), unrelated);
});

test("creates missing draft templates without replacing existing files", async () => {
  const existing = await writeProject(root);
  const original = await fs.readFile(existing, "utf8");
  const repo = createProjectMarkdownRepository({ kbDir: root, now: () => "2026-07-12T09:00:00+08:00" });
  const result = await repo.ensureDraftTemplates([
    { projectId: "personal-ip", name: "个人IP", milestoneId: "ip-start", milestoneName: "启动", deliverableId: "ip-first", deliverableName: "首个交付项" },
    { projectId: "jixiang-os", name: "极享OS", milestoneId: "os-start", milestoneName: "启动", deliverableId: "os-first", deliverableName: "首个交付项" },
  ]);
  assert.deepEqual(result.created.map((project) => project.id), ["jixiang-os"]);
  assert.equal(await fs.readFile(existing, "utf8"), original);
  assert.equal((await repo.readProject("jixiang-os")).status, "draft");
});

test("confirms a draft after checking its hash", async () => {
  const timestamps = ["2026-07-12T09:00:00+08:00", "2026-07-12T10:00:00+08:00"];
  const repo = createProjectMarkdownRepository({ kbDir: root, now: () => timestamps.shift() });
  await repo.ensureDraftTemplates([
    { projectId: "personal-ip", name: "个人IP", milestoneId: "ip-start", milestoneName: "启动", deliverableId: "ip-first", deliverableName: "首个交付项" },
  ]);
  const draft = await repo.readProject("personal-ip");
  const confirmed = await repo.confirmDraft("personal-ip", draft.contentHash);
  assert.equal(confirmed.status, "active");
  assert.equal(confirmed.updatedAt, draft.updatedAt);
  assert.equal(
    await fs.readFile(confirmed.filePath, "utf8"),
    draft.rawContent.replace(/^status: draft$/m, "status: active"),
  );
});

test("applies deliverable add, update, and remove changes", async () => {
  await writeProject(root);
  let changeSequence = 0;
  const repo = createProjectMarkdownRepository({ kbDir: root, id: () => `change-${changeSequence += 1}` });
  let project = await repo.readProject("personal-ip");

  project = await repo.applyDeliverableChanges({
    projectId: project.id,
    expectedHash: project.contentHash,
    changes: [
      { action: "update", milestoneId: "content-validation", deliverableId: "video-02", weight: 70 },
      { action: "add", milestoneId: "content-validation", deliverableId: "video-03", name: "发布第 3 条短视频", weight: 20 },
    ],
  });
  assert.deepEqual(
    project.milestones[0].deliverables.map(({ id, weight }) => [id, weight]),
    [["video-01", 10], ["video-02", 70], ["video-03", 20]],
  );

  project = await repo.applyDeliverableChanges({
    projectId: project.id,
    expectedHash: project.contentHash,
    changes: [
      { action: "update", milestoneId: "content-validation", deliverableId: "video-01", name: "发布首条短视频", weight: 20 },
      { action: "update", milestoneId: "content-validation", deliverableId: "video-02", weight: 60 },
    ],
  });
  assert.deepEqual(
    project.milestones[0].deliverables.map(({ id, name, weight }) => [id, name, weight]),
    [["video-01", "发布首条短视频", 20], ["video-02", "发布其他短视频", 60], ["video-03", "发布第 3 条短视频", 20]],
  );

  project = await repo.applyDeliverableChanges({
    projectId: project.id,
    expectedHash: project.contentHash,
    changes: [
      { action: "update", milestoneId: "content-validation", deliverableId: "video-02", weight: 80 },
      { action: "remove", milestoneId: "content-validation", deliverableId: "video-03" },
    ],
  });
  assert.deepEqual(
    project.milestones[0].deliverables.map(({ id, weight }) => [id, weight]),
    [["video-01", 20], ["video-02", 80]],
  );
});

test("accepts a deliverable without changing free notes", async () => {
  await writeProject(root);
  const repo = createProjectMarkdownRepository({ kbDir: root, now: () => "2026-07-12T10:20:30+08:00", id: () => "change-1" });
  const before = await repo.readProject("personal-ip");
  const outsideBefore = outsideManaged(before.rawContent);
  const result = await repo.acceptDeliverable({
    projectId: "personal-ip", deliverableId: "video-01",
    evidence: "https://example.com/v/1", expectedHash: before.contentHash,
  });
  assert.equal(result.projectProgress, 10);
  assert.deepEqual(outsideManaged(await fs.readFile(before.filePath, "utf8")), outsideBefore);
  const logs = await fs.readdir(path.join(root, "项目变更记录"));
  assert.equal(logs.length, 1);
  assert.match(await fs.readFile(path.join(root, "项目变更记录", logs[0]), "utf8"), /https:\/\/example\.com\/v\/1/);
});

test("refuses to overwrite concurrent human edits", async () => {
  await writeProject(root);
  const repo = createProjectMarkdownRepository({ kbDir: root });
  const before = await repo.readProject("personal-ip");
  await fs.appendFile(before.filePath, "\n人工修改");
  await assert.rejects(() => repo.acceptDeliverable({
    projectId: "personal-ip", deliverableId: "video-01", evidence: "x", expectedHash: before.contentHash,
  }), /project changed since read/);
});

test("durable receipt resumes a crash before Markdown replacement with the exact delta", async () => {
  await writeProject(root);
  let fail = true;
  const repo = createProjectMarkdownRepository({ kbDir: root, failureInjector(point) {
    if (fail && point === "after_receipt_write") throw new Error("crash after receipt");
  } });
  const before = await repo.readProject("personal-ip");
  const input = { projectId: "personal-ip", deliverableId: "video-01", evidence: "proof", expectedHash: before.contentHash, operationKey: "acceptance-a1" };

  await assert.rejects(() => repo.acceptDeliverable(input), /crash after receipt/);
  assert.equal((await repo.readProject("personal-ip")).contentHash, before.contentHash);
  fail = false;
  const recovered = await repo.acceptDeliverable(input);
  assert.equal(recovered.beforeProgress, 0);
  assert.equal(recovered.projectProgress, 10);
  assert.equal((await fs.readdir(path.join(root, "项目变更记录"))).length, 1);
});

test("durable receipt recognizes a crash after Markdown replacement without duplicating progress", async () => {
  await writeProject(root);
  let fail = true;
  const repo = createProjectMarkdownRepository({ kbDir: root, failureInjector(point) {
    if (fail && point === "after_markdown_write") throw new Error("crash after markdown");
  } });
  const before = await repo.readProject("personal-ip");
  const input = { projectId: "personal-ip", deliverableId: "video-01", evidence: "proof", expectedHash: before.contentHash, operationKey: "acceptance-a1" };

  await assert.rejects(() => repo.acceptDeliverable(input), /crash after markdown/);
  assert.equal((await repo.readProject("personal-ip")).progress, 10);
  fail = false;
  const recovered = await repo.acceptDeliverable(input);
  assert.equal(recovered.beforeProgress, 0);
  assert.equal(recovered.projectProgress, 10);
  assert.equal((await fs.readdir(path.join(root, "项目变更记录"))).length, 1);
});

test("receipt write failure leaves Markdown untouched and no receipt", async () => {
  await writeProject(root);
  const repo = createProjectMarkdownRepository({ kbDir: root, failureInjector(point) {
    if (point === "before_receipt_write") throw new Error("receipt unavailable");
  } });
  const before = await repo.readProject("personal-ip");
  await assert.rejects(() => repo.acceptDeliverable({ projectId: "personal-ip", deliverableId: "video-01", evidence: "proof", expectedHash: before.contentHash, operationKey: "acceptance-a1" }), /receipt unavailable/);
  assert.equal((await repo.readProject("personal-ip")).contentHash, before.contentHash);
  await assert.rejects(() => fs.readdir(path.join(root, "项目变更记录")), /ENOENT/);
});

test("receipt reapplies a reverted effect but rejects unrelated edits", async () => {
  await writeProject(root);
  let fail = true;
  const repo = createProjectMarkdownRepository({ kbDir: root, failureInjector(point) {
    if (fail && point === "after_receipt_write") throw new Error("stop");
  } });
  const before = await repo.readProject("personal-ip");
  const input = { projectId: "personal-ip", deliverableId: "video-01", evidence: "proof", expectedHash: before.contentHash, operationKey: "acceptance-a1" };
  await assert.rejects(() => repo.acceptDeliverable(input), /stop/);
  fail = false;
  await fs.appendFile(before.filePath, "\n人工无关修改");
  await assert.rejects(() => repo.acceptDeliverable(input), /reconciliation conflict/);
  await fs.writeFile(before.filePath, before.rawContent, "utf8");
  assert.equal((await repo.acceptDeliverable(input)).projectProgress, 10);
});

test("recovers a legacy accepted effect without a receipt and reconstructs the exact delta", async () => {
  await writeProject(root);
  const legacy = createProjectMarkdownRepository({ kbDir: root });
  const before = await legacy.readProject("personal-ip");
  await legacy.acceptDeliverable({ projectId: "personal-ip", deliverableId: "video-01", evidence: "proof", expectedHash: before.contentHash });
  await fs.rm(path.join(root, "项目变更记录"), { recursive: true, force: true });
  const current = await legacy.readProject("personal-ip");

  const recovered = await legacy.acceptDeliverable({ projectId: "personal-ip", deliverableId: "video-01", evidence: "proof", expectedHash: current.contentHash, operationKey: "acceptance-a1" });
  assert.equal(recovered.beforeProgress, 0);
  assert.equal(recovered.projectProgress, 10);
  const receipt = JSON.parse(await fs.readFile(path.join(root, "项目变更记录", "acceptance-a1.json"), "utf8"));
  assert.equal(receipt.recovered, true);
  assert.equal(receipt.afterHash, current.contentHash);
});
