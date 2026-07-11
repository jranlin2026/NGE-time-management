import assert from "node:assert/strict";
import test from "node:test";
import { openDatabase, withTransaction } from "../src/db/database.mjs";
import { createTaskRepository } from "../src/db/task-repository.mjs";
import { createOperationsRepository } from "../src/db/operations-repository.mjs";
import { createProjectOperationsRepository } from "../src/db/project-operations-repository.mjs";
import { createAcceptanceService } from "../src/lib/acceptance-service.mjs";

function setup(analyzeAcceptance, failureInjector) {
  const db = openDatabase(":memory:");
  const tasks = createTaskRepository(db);
  const ops = createOperationsRepository(db);
  const acceptances = createProjectOperationsRepository(db);
  const service = createAcceptanceService({ tasks, ops, acceptances, transaction: (fn) => withTransaction(db, fn), analyzer: { analyzeAcceptance }, failureInjector });
  return { db, tasks, ops, acceptances, service };
}

function pending(fixture, input) {
  const task = fixture.tasks.create({ status: "pending_acceptance", requiresEvidence: true, deliverableId: "deliverable-1", ...input });
  fixture.acceptances.saveAcceptance({ taskId: task.id, deliverableId: task.deliverableId, status: "pending", evidence: [] });
  return task;
}

test("falls back to user confirmation when acceptance analysis fails", async () => {
  const { db, tasks, ops, service } = setup(async () => { throw new Error("Codex offline"); });
  pending({ tasks, acceptances: createProjectOperationsRepository(db) }, { id: "deliverable", title: "交付脚本" });
  const result = await service.submit({ taskId: "deliverable", evidence: [{ type: "url", value: "https://unreachable.invalid/result" }] });

  assert.equal(result.status, "needs_user_confirmation");
  assert.match(result.explanation, /Codex offline/);
  assert.equal(tasks.findById("deliverable").status, "pending_acceptance");
  assert.equal(ops.listOutbox().at(-1).kind, "acceptance_review_card");
  db.close();
});

test("never auto-passes an image reference that cannot be inspected", async () => {
  let analyzed = false;
  const { db, tasks, service } = setup(async () => { analyzed = true; return { status: "accepted" }; });
  const acceptances = createProjectOperationsRepository(db);
  pending({ tasks, acceptances }, { id: "image", title: "海报" });
  const result = await service.submit({ taskId: "image", evidence: [{ type: "feishu_image", value: "img_1" }] });
  assert.equal(result.status, "needs_user_confirmation");
  assert.equal(analyzed, false);
  db.close();
});

test("does not auto-pass a syntactically valid but irrelevant URL", async () => {
  const fixture = setup(async () => ({ status: "rejected", explanation: "链接内容与任务无关" }));
  pending(fixture, { id: "irrelevant", title: "发布视频" });
  const result = await fixture.service.submit({ taskId: "irrelevant", evidence: [{ type: "url", value: "https://example.com/weather" }] });
  assert.equal(result.status, "rejected");
  assert.equal(fixture.tasks.findById("irrelevant").status, "doing");
  fixture.db.close();
});

test("sends sufficient URL evidence to the analyzer and rejects insufficient quantity", async () => {
  let analyzed = 0;
  const fixture = setup(async () => { analyzed += 1; return { status: "needs_user_confirmation", explanation: "无法验证链接内容" }; });
  const { db, tasks, service } = fixture;
  pending(fixture, { id: "enough", title: "发布", doneDefinition: "发布 2 条视频" });
  pending(fixture, { id: "short", title: "发布", doneDefinition: "发布 2 条视频" });
  const accepted = await service.submit({ taskId: "enough", evidence: [
    { type: "url", value: "https://example.com/1" }, { type: "url", value: "https://example.com/2" },
  ] });
  const rejected = await service.submit({ taskId: "short", evidence: [{ type: "url", value: "https://example.com/1" }] });
  assert.equal(accepted.status, "needs_user_confirmation");
  assert.equal(tasks.findById("enough").status, "pending_acceptance");
  assert.equal(analyzed, 1);
  assert.equal(rejected.status, "rejected");
  assert.equal(tasks.findById("short").status, "doing");
  db.close();
});

test("lets the user decide a manual review", async () => {
  const { db, tasks, service } = setup(async () => ({ status: "needs_user_confirmation" }));
  const acceptances = createProjectOperationsRepository(db);
  pending({ tasks, acceptances }, { id: "manual", title: "海报" });
  const result = await service.decideByUser({ taskId: "manual", accepted: true, explanation: "已人工查看" });
  assert.equal(result.status, "accepted");
  assert.equal(result.task.status, "done");
  db.close();
});

test("rejects late evidence before writing a durable submission event", async () => {
  const fixture = setup(async () => ({ status: "accepted", explanation: "ok" }));
  fixture.tasks.create({ id: "late", title: "已结束", status: "done", deliverableId: "deliverable-1", requiresEvidence: true });
  await assert.rejects(() => fixture.service.submit({ taskId: "late", evidence: [{ type: "text", value: "迟到证据" }], idempotencyKey: "late-1" }), /not pending acceptance/);
  assert.equal(fixture.ops.findEventByIdempotencyKey("late-1"), null);
  fixture.db.close();
});

for (const stage of ["after_acceptance_write", "after_task_write", "after_transition_event_write", "after_event_write"]) {
  test(`rolls back ${stage} and converges on retry`, async () => {
    let shouldFail = true;
    const fixture = setup(async () => ({ status: "accepted", explanation: "证据相关且可读" }), (point) => {
      if (shouldFail && point === stage) throw new Error(`injected ${stage}`);
    });
    pending(fixture, { id: stage, title: "发布视频" });
    const input = { taskId: stage, evidence: [{ type: "url", value: "https://example.com/video" }], idempotencyKey: `submit:${stage}` };
    await assert.rejects(() => fixture.service.submit(input), new RegExp(stage));
    assert.equal(fixture.tasks.findById(stage).status, "pending_acceptance");
    assert.equal(fixture.acceptances.findPendingAcceptanceByTask(stage).status, "pending");
    assert.equal(fixture.ops.findEventByIdempotencyKey(input.idempotencyKey), null);
    shouldFail = false;
    const result = await fixture.service.submit(input);
    const duplicate = await fixture.service.submit(input);
    assert.equal(result.status, "accepted");
    assert.equal(duplicate.status, "accepted");
    assert.equal(duplicate.duplicate, true);
    assert.equal(fixture.tasks.findById(stage).status, "done");
    fixture.db.close();
  });
}

test("records exactly one transition audit and one submission event across retries", async () => {
  const fixture = setup(async () => ({ status: "accepted", explanation: "证据相关且可读" }));
  pending(fixture, { id: "audited", title: "发布视频" });
  const input = { taskId: "audited", evidence: [{ type: "url", value: "https://example.com/video" }], idempotencyKey: "submit:audited" };
  await fixture.service.submit(input);
  const duplicate = await fixture.service.submit(input);
  assert.equal(duplicate.acceptanceId, duplicate.acceptance.id);
  assert.equal(fixture.ops.listEvents({ taskId: "audited", kind: "task_accepted" }).length, 1);
  assert.equal(fixture.ops.listEvents({ taskId: "audited", kind: "acceptance_evidence_submitted" }).length, 1);
  assert.equal(fixture.ops.findEventByIdempotencyKey("submit:audited:transition").kind, "task_accepted");
  fixture.db.close();
});

test("rolls back a manual-review outbox failure and retries once", async () => {
  let shouldFail = true;
  const fixture = setup(async () => ({ status: "needs_user_confirmation", explanation: "链接不可达" }), (point) => {
    if (shouldFail && point === "after_outbox_write") throw new Error("injected after_outbox_write");
  });
  pending(fixture, { id: "outbox", title: "发布视频" });
  const input = { taskId: "outbox", evidence: [{ type: "url", value: "https://invalid.example/video" }], idempotencyKey: "submit:outbox" };
  await assert.rejects(() => fixture.service.submit(input), /after_outbox_write/);
  assert.equal(fixture.ops.listOutbox().length, 0);
  assert.equal(fixture.ops.findEventByIdempotencyKey(input.idempotencyKey), null);
  shouldFail = false;
  assert.equal((await fixture.service.submit(input)).status, "needs_user_confirmation");
  assert.equal(fixture.ops.listOutbox().length, 1);
  fixture.db.close();
});
