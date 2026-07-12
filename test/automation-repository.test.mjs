import assert from "node:assert/strict";
import test from "node:test";
import { createAutomationRepository } from "../src/db/automation-repository.mjs";
import { openDatabase } from "../src/db/database.mjs";

function fixture() {
  const db = openDatabase(":memory:");
  return { db, repo: createAutomationRepository(db) };
}

test("claims one global runner until the lease expires", () => {
  const db = openDatabase(":memory:");
  const clock = { value: "2026-07-13T00:00:00.000Z" };
  const repo = createAutomationRepository(db, { now: () => clock.value });
  assert.equal(repo.claimLock({ owner: "run-a", expiresAt: "2026-07-13T00:05:00.000Z" }), true);
  assert.equal(repo.claimLock({ owner: "run-b", expiresAt: "2026-07-13T00:05:00.000Z" }), false);
  clock.value = "2026-07-13T00:06:00.000Z";
  assert.equal(repo.claimLock({ owner: "run-b", expiresAt: "2026-07-13T00:11:00.000Z" }), true);
  assert.equal(repo.releaseLock("run-a"), false);
  assert.equal(repo.releaseLock("run-b"), true);
  db.close();
});

test("does not process one inbound message twice", () => {
  const db = openDatabase(":memory:");
  const repo = createAutomationRepository(db, { now: () => "2026-07-13T01:00:00.000Z" });
  const message = { messageId: "om-1", chatId: "oc-p2p", senderId: "ou-owner", messageType: "text", content: { text: "新增选题" }, createdAt: "2026-07-13T00:30:00.000Z" };
  repo.recordInbound([message, message]);
  assert.deepEqual(repo.listPendingInbound("oc-p2p").map((item) => item.messageId), ["om-1"]);
  repo.claimRun({ runKey: "2026-07-13:09:00", workDate: "2026-07-13", node: "09:00", expiresAt: "2026-07-13T01:05:00.000Z" });
  repo.markInboundProcessed(["om-1"], "2026-07-13:09:00");
  assert.deepEqual(repo.listPendingInbound("oc-p2p"), []);
  db.close();
});

test("maps parent and checkpoint GUIDs independently", () => {
  const { db, repo } = fixture();
  db.prepare(`INSERT INTO tasks (id,title,raw_input,next_action,done_definition,created_at,updated_at)
    VALUES ('task-1','选题','输入','写稿','交付','2026-07-13','2026-07-13')`).run();
  repo.upsertFeishuLink({ localTaskId: "task-1", checkpointIndex: -1, taskGuid: "parent-1", parentGuid: null, snapshotHash: "a" });
  repo.upsertFeishuLink({ localTaskId: "task-1", checkpointIndex: 0, taskGuid: "child-1", parentGuid: "parent-1", snapshotHash: "b" });
  assert.equal(repo.findFeishuLink("task-1", -1).taskGuid, "parent-1");
  assert.equal(repo.findFeishuLink("task-1", 0).parentGuid, "parent-1");
  assert.deepEqual(repo.listFeishuLinks("task-1").map((link) => link.checkpointIndex), [-1, 0]);
  db.close();
});

test("advances one chat cursor only after successful finalization", () => {
  const db = openDatabase(":memory:");
  const repo = createAutomationRepository(db, { now: () => "2026-07-13T01:00:00.000Z" });
  assert.equal(repo.getMessageCursor("oc-p2p"), null);
  repo.advanceMessageCursor("oc-p2p", "2026-07-13T01:00:00.000Z");
  assert.equal(repo.getMessageCursor("oc-p2p").polledThrough, "2026-07-13T01:00:00.000Z");
  db.close();
});

test("completed runs cannot be reclaimed while failed and expired runs can resume", () => {
  const db = openDatabase(":memory:");
  const clock = { value: "2026-07-13T01:00:00.000Z" };
  const repo = createAutomationRepository(db, { now: () => clock.value });
  const input = { runKey: "run-1", workDate: "2026-07-13", node: "09:00", expiresAt: "2026-07-13T01:05:00.000Z" };
  assert.equal(repo.claimRun(input).claimed, true);
  assert.equal(repo.claimRun(input).claimed, false);
  repo.failRun("run-1", "x".repeat(600));
  assert.equal(repo.claimRun(input).claimed, true);
  repo.completeRun("run-1", { processed: 1 });
  assert.equal(repo.claimRun(input).claimed, false);
  assert.equal(db.prepare("SELECT length(error) AS size FROM automation_runs WHERE run_key='run-1'").get().size, null);

  const second = { ...input, runKey: "run-2" };
  assert.equal(repo.claimRun(second).claimed, true);
  clock.value = "2026-07-13T01:06:00.000Z";
  assert.equal(repo.claimRun({ ...second, expiresAt: "2026-07-13T01:11:00.000Z" }).claimed, true);
  db.close();
});

test("sanitizes stored run errors to 500 characters", () => {
  const db = openDatabase(":memory:");
  const repo = createAutomationRepository(db, { now: () => "2026-07-13T01:00:00.000Z" });
  repo.claimRun({ runKey: "run-1", workDate: "2026-07-13", node: "09:00", expiresAt: "2026-07-13T01:05:00.000Z" });
  repo.failRun("run-1", new Error("x".repeat(600)));
  assert.equal(db.prepare("SELECT length(error) AS size FROM automation_runs WHERE run_key='run-1'").get().size, 500);
  db.close();
});
