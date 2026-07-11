import assert from "node:assert/strict";
import test from "node:test";
import { openDatabase } from "../src/db/database.mjs";
import { createTaskRepository } from "../src/db/task-repository.mjs";
import { createOperationsRepository } from "../src/db/operations-repository.mjs";
import { createAcceptanceService } from "../src/lib/acceptance-service.mjs";

function setup(analyzeAcceptance) {
  const db = openDatabase(":memory:");
  const tasks = createTaskRepository(db);
  const ops = createOperationsRepository(db);
  const service = createAcceptanceService({ tasks, ops, analyzer: { analyzeAcceptance } });
  return { db, tasks, ops, service };
}

test("falls back to user confirmation when acceptance analysis fails", async () => {
  const { db, tasks, ops, service } = setup(async () => { throw new Error("Codex offline"); });
  tasks.create({ id: "deliverable", title: "交付脚本", status: "pending_acceptance", requiresEvidence: true });
  const result = await service.submit({ taskId: "deliverable", evidence: [{ type: "text", value: "已交付" }] });

  assert.equal(result.status, "needs_user_confirmation");
  assert.match(result.explanation, /Codex offline/);
  assert.equal(tasks.findById("deliverable").status, "pending_acceptance");
  assert.equal(ops.listOutbox().at(-1).kind, "acceptance_review_card");
  db.close();
});

test("never auto-passes an image reference that cannot be inspected", async () => {
  let analyzed = false;
  const { db, tasks, service } = setup(async () => { analyzed = true; return { status: "accepted" }; });
  tasks.create({ id: "image", title: "海报", status: "pending_acceptance", requiresEvidence: true });
  const result = await service.submit({ taskId: "image", evidence: [{ type: "feishu_image", value: "img_1" }] });
  assert.equal(result.status, "needs_user_confirmation");
  assert.equal(analyzed, false);
  db.close();
});

test("accepts sufficient URL evidence and rejects insufficient quantity", async () => {
  const { db, tasks, service } = setup(async () => ({ status: "needs_user_confirmation" }));
  tasks.create({ id: "enough", title: "发布", doneDefinition: "发布 2 条视频", status: "pending_acceptance", requiresEvidence: true });
  tasks.create({ id: "short", title: "发布", doneDefinition: "发布 2 条视频", status: "pending_acceptance", requiresEvidence: true });
  const accepted = await service.submit({ taskId: "enough", evidence: [
    { type: "url", value: "https://example.com/1" }, { type: "url", value: "https://example.com/2" },
  ] });
  const rejected = await service.submit({ taskId: "short", evidence: [{ type: "url", value: "https://example.com/1" }] });
  assert.equal(accepted.status, "accepted");
  assert.equal(tasks.findById("enough").status, "done");
  assert.equal(rejected.status, "rejected");
  assert.equal(tasks.findById("short").status, "doing");
  db.close();
});

test("lets the user decide a manual review", async () => {
  const { db, tasks, service } = setup(async () => ({ status: "needs_user_confirmation" }));
  tasks.create({ id: "manual", title: "海报", status: "pending_acceptance", requiresEvidence: true });
  const result = await service.decideByUser({ taskId: "manual", accepted: true, explanation: "已人工查看" });
  assert.equal(result.status, "accepted");
  assert.equal(result.task.status, "done");
  db.close();
});
