import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openDatabase, withTransaction } from "../src/db/database.mjs";
import { createOperationsRepository } from "../src/db/operations-repository.mjs";
import { createProjectOperationsRepository } from "../src/db/project-operations-repository.mjs";
import { createTaskRepository } from "../src/db/task-repository.mjs";
import { createAcceptanceService } from "../src/lib/acceptance-service.mjs";
import { computeProjectProgress, createProjectMarkdownRepository } from "../src/lib/project-markdown-repository.mjs";

let root;

test.beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "project-progress-"));
});

test.afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function setup({ failureInjector, repoFailureInjector } = {}) {
  await writeProject(root);
  const db = openDatabase(":memory:");
  const tasks = createTaskRepository(db);
  const ops = createOperationsRepository(db);
  const acceptances = createProjectOperationsRepository(db, { id: () => "acceptance-1" });
  const markdownRepo = createProjectMarkdownRepository({ kbDir: root, now: () => "2026-07-12T10:20:30+08:00", failureInjector: repoFailureInjector });
  let acceptCalls = 0;
  const projectRepo = {
    readProject: (...args) => markdownRepo.readProject(...args),
    async acceptDeliverable(...args) {
      acceptCalls += 1;
      return markdownRepo.acceptDeliverable(...args);
    },
  };
  const service = createAcceptanceService({
    tasks, ops, acceptances, projectRepo,
    transaction: (fn) => withTransaction(db, fn),
    analyzer: { analyzeAcceptance: async () => ({ status: "accepted", explanation: "证据相关且可读" }) },
    failureInjector,
  });
  return { db, tasks, ops, acceptances, projectRepo, markdownRepo, service, acceptCalls: () => acceptCalls };
}

function pending(fixture, input = {}) {
  const task = fixture.tasks.create({
    id: "critical", title: "发布首条短视频", status: "pending_acceptance", requiresEvidence: true,
    projectId: "personal-ip", milestoneId: "content-validation", deliverableId: "video-01",
    doneDefinition: "发布 1 条视频", ...input,
  });
  fixture.acceptances.saveAcceptance({ id: "acceptance-1", taskId: task.id, deliverableId: task.deliverableId, status: "pending", evidence: [] });
  return task;
}

test("accepted evidence writes project progress exactly once across duplicate submission", async () => {
  const fixture = await setup();
  pending(fixture);
  const evidence = [{ type: "url", value: "https://example.com/video" }];

  const first = await fixture.service.submit({ taskId: "critical", evidence, idempotencyKey: "evidence-1" });
  const second = await fixture.service.submit({ taskId: "critical", evidence, idempotencyKey: "evidence-1" });

  assert.equal(second.acceptanceId, first.acceptanceId);
  assert.equal(fixture.tasks.findById("critical").status, "done");
  assert.equal(computeProjectProgress(await fixture.projectRepo.readProject("personal-ip")), 10);
  assert.equal(fixture.ops.listEvents({ taskId: "critical", kind: "task_accepted" }).length, 1);
  assert.equal(fixture.acceptCalls(), 1);
  assert.equal((await fs.readdir(path.join(root, "项目变更记录"))).length, 1);
  assert.equal(fixture.ops.listOutbox().filter((row) => row.kind === "project_progress_card").length, 1);
  fixture.db.close();
});

test("reconciles SQLite after Markdown was accepted without applying progress twice", async () => {
  let failOnce = true;
  const fixture = await setup({ failureInjector(point) {
    if (failOnce && point === "after_acceptance_write") {
      failOnce = false;
      throw new Error("injected sqlite failure");
    }
  } });
  pending(fixture);
  const input = { taskId: "critical", evidence: [{ type: "url", value: "https://example.com/video" }], idempotencyKey: "evidence-retry" };

  await assert.rejects(() => fixture.service.submit(input), /injected sqlite failure/);
  assert.equal(computeProjectProgress(await fixture.projectRepo.readProject("personal-ip")), 10);
  assert.equal(fixture.tasks.findById("critical").status, "pending_acceptance");
  assert.equal(fixture.ops.listEvents({ taskId: "critical", kind: "project_sync_reconciliation_required" }).length, 1);

  const result = await fixture.service.submit(input);
  assert.equal(result.status, "accepted");
  assert.equal(fixture.tasks.findById("critical").status, "done");
  assert.equal((await fs.readdir(path.join(root, "项目变更记录"))).length, 1);
  assert.equal(fixture.acceptances.getSyncState("personal-ip").contentHash, (await fixture.projectRepo.readProject("personal-ip")).contentHash);
  const progressCard = fixture.ops.listOutbox().find((row) => row.kind === "project_progress_card");
  assert.equal(progressCard.payload.beforeProgress, 0);
  assert.equal(progressCard.payload.afterProgress, 10);
  fixture.db.close();
});

test("rejection restores doing and creates one stable rework task for the same deliverable", async () => {
  const fixture = await setup();
  fixture.service = createAcceptanceService({
    tasks: fixture.tasks, ops: fixture.ops, acceptances: fixture.acceptances, projectRepo: fixture.projectRepo,
    transaction: (fn) => withTransaction(fixture.db, fn),
    analyzer: { analyzeAcceptance: async () => ({ status: "rejected", explanation: "画面缺少字幕" }) },
  });
  pending(fixture);
  const input = { taskId: "critical", evidence: [{ type: "url", value: "https://example.com/video" }], idempotencyKey: "evidence-rejected" };

  const rejected = await fixture.service.submit(input);
  const duplicate = await fixture.service.submit(input);
  const rework = fixture.tasks.findById(rejected.reworkTaskId);

  assert.equal(fixture.tasks.findById("critical").status, "doing");
  assert.equal(rejected.reworkTaskId, "rework:acceptance-1");
  assert.equal(duplicate.reworkTaskId, rejected.reworkTaskId);
  assert.equal(rework.deliverableId, "video-01");
  assert.equal(rework.requiresEvidence, true);
  assert.equal(rework.nextAction, "画面缺少字幕");
  assert.equal(fixture.tasks.listAll().filter((task) => task.id === rejected.reworkTaskId).length, 1);
  fixture.db.close();
});

test("manual acceptance by acceptance id writes project progress and is idempotent", async () => {
  const fixture = await setup();
  pending(fixture);
  await fixture.service.submit({
    taskId: "critical",
    evidence: [{ type: "feishu_image", value: "img_1" }],
    idempotencyKey: "manual-review-request",
  });

  const first = await fixture.service.decideByUser({ acceptanceId: "acceptance-1", decision: "accepted", explanation: "已人工查看", idempotencyKey: "manual-1" });
  const second = await fixture.service.decideByUser({ acceptanceId: "acceptance-1", decision: "accepted", explanation: "已人工查看", idempotencyKey: "manual-1" });

  assert.equal(first.status, "accepted");
  assert.equal(second.acceptanceId, first.acceptanceId);
  assert.equal(fixture.tasks.findById("critical").status, "done");
  assert.equal(computeProjectProgress(await fixture.projectRepo.readProject("personal-ip")), 10);
  assert.equal(fixture.acceptCalls(), 1);
  fixture.db.close();
});

test("project receipt conflict keeps acceptance pending and converges after restoring the before hash", async () => {
  let failAfterReceipt = true;
  const fixture = await setup({ repoFailureInjector(point) {
    if (failAfterReceipt && point === "after_receipt_write") {
      failAfterReceipt = false;
      throw new Error("crash after receipt");
    }
  } });
  pending(fixture);
  const before = await fixture.projectRepo.readProject("personal-ip");
  const input = { taskId: "critical", evidence: [{ type: "url", value: "https://example.com/video" }], idempotencyKey: "receipt-conflict" };

  await assert.rejects(() => fixture.service.submit(input), /crash after receipt/);
  await fs.appendFile(before.filePath, "\n人工并发修改");
  await assert.rejects(() => fixture.service.submit(input), /reconciliation conflict/);
  assert.equal(fixture.tasks.findById("critical").status, "pending_acceptance");
  assert.equal(fixture.acceptances.getAcceptance("acceptance-1").status, "pending");
  assert.equal(fixture.ops.listEvents({ taskId: "critical", kind: "project_sync_reconciliation_required" }).length, 1);

  await fs.writeFile(before.filePath, before.rawContent, "utf8");
  const recovered = await fixture.service.submit(input);
  assert.equal(recovered.status, "accepted");
  assert.equal(fixture.tasks.findById("critical").status, "done");
  assert.equal(fixture.ops.listEvents({ taskId: "critical", kind: "task_accepted" }).length, 1);
  assert.equal(fixture.ops.listOutbox().filter((row) => row.kind === "project_progress_card").length, 1);
  assert.deepEqual(fixture.ops.listOutbox().find((row) => row.kind === "project_progress_card").payload.beforeProgress, 0);
  assert.equal((await fs.readdir(path.join(root, "项目变更记录"))).length, 1);
  fixture.db.close();
});

test("manual acceptance resumes the same receipt boundary and rejects invalid decisions without writes", async () => {
  let failAfterMarkdown = true;
  const fixture = await setup({ repoFailureInjector(point) {
    if (failAfterMarkdown && point === "after_markdown_write") {
      failAfterMarkdown = false;
      throw new Error("manual crash after markdown");
    }
  } });
  pending(fixture);
  await fixture.service.submit({ taskId: "critical", evidence: [{ type: "feishu_image", value: "img_1" }], idempotencyKey: "manual-review-request" });
  const eventsBeforeInvalid = fixture.ops.listEvents().length;
  await assert.rejects(() => fixture.service.decideByUser({ acceptanceId: "acceptance-1", decision: "maybe", idempotencyKey: "manual-invalid" }), /invalid acceptance decision/);
  assert.equal(fixture.ops.listEvents().length, eventsBeforeInvalid);
  assert.equal((await fixture.projectRepo.readProject("personal-ip")).progress, 0);

  const input = { acceptanceId: "acceptance-1", decision: "accepted", explanation: "人工确认", idempotencyKey: "manual-receipt" };
  await assert.rejects(() => fixture.service.decideByUser(input), /manual crash after markdown/);
  assert.equal(fixture.tasks.findById("critical").status, "pending_acceptance");
  const recovered = await fixture.service.decideByUser(input);
  assert.equal(recovered.status, "accepted");
  assert.equal(fixture.tasks.findById("critical").status, "done");
  assert.equal(fixture.ops.listOutbox().filter((row) => row.kind === "project_progress_card").length, 1);
  assert.equal((await fs.readdir(path.join(root, "项目变更记录"))).length, 1);
  fixture.db.close();
});

async function writeProject(kbDir) {
  const projectDir = path.join(kbDir, "项目");
  await fs.mkdir(projectDir, { recursive: true });
  await fs.writeFile(path.join(projectDir, "个人IP.md"), `---
project_id: personal-ip
name: 个人IP
status: active
priority: 1
updated_at: 2026-07-12T08:00:00+08:00
---

# 个人IP

<!-- time-manager:managed:start -->
## 当前阶段

内容冷启动

## 里程碑

| milestone_id | 名称 | 截止时间 | 项目权重 | 状态 |
| --- | --- | --- | ---: | --- |
| content-validation | 验证内容方向 | 2026-07-31 | 100 | active |

## 里程碑交付项

| deliverable_id | milestone_id | 交付项 | 里程碑权重 | 状态 | 验收证据 |
| --- | --- | --- | ---: | --- | --- |
| video-01 | content-validation | 发布第 1 条短视频 | 10 | pending | |
| video-02 | content-validation | 发布其他短视频 | 90 | pending | |

## 当前风险

- 暂无。

## 下一步候选

- 发布第 2 条短视频。

## 最近一次实质成果

尚无。
<!-- time-manager:managed:end -->
`, "utf8");
}
