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

test("reads structured projects and computes accepted weighted progress", async () => {
  await writeProject(root, { deliverableStatus: "accepted" });
  const repo = createProjectMarkdownRepository({ kbDir: root });
  const project = await repo.readProject("personal-ip");
  assert.equal(project.milestones[0].deliverables[0].id, "video-01");
  assert.equal(computeProjectProgress(project), 10);
  assert.equal(project.status, "active");
  assert.match(project.contentHash, /^[a-f0-9]{64}$/);
});

test("rejects weights that do not total one hundred", async () => {
  await writeProject(root, { milestoneWeight: 90 });
  const repo = createProjectMarkdownRepository({ kbDir: root });
  await assert.rejects(() => repo.readProject("personal-ip"), ProjectFormatError);
});

test("lists valid project markdown files", async () => {
  await writeProject(root);
  const projects = await createProjectMarkdownRepository({ kbDir: root }).listProjects();
  assert.deepEqual(projects.map((project) => project.id), ["personal-ip"]);
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
  assert.match(await fs.readFile(confirmed.filePath, "utf8"), /status: active/);
});

test("accepts a deliverable without changing free notes", async () => {
  await writeProject(root);
  const repo = createProjectMarkdownRepository({ kbDir: root, now: () => "2026-07-12T10:20:30+08:00", id: () => "change-1" });
  const before = await repo.readProject("personal-ip");
  const result = await repo.acceptDeliverable({
    projectId: "personal-ip", deliverableId: "video-01",
    evidence: "https://example.com/v/1", expectedHash: before.contentHash,
  });
  assert.equal(result.projectProgress, 10);
  assert.match(await fs.readFile(before.filePath, "utf8"), /我的自由笔记\n不要修改/);
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
