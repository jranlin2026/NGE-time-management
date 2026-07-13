import assert from "node:assert/strict";
import test from "node:test";
import { createAutomationRepository } from "../src/db/automation-repository.mjs";
import { openDatabase } from "../src/db/database.mjs";
import { createTaskRepository } from "../src/db/task-repository.mjs";

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
  const claim = repo.claimRun({ runKey: "2026-07-13:09:00", workDate: "2026-07-13", node: "09:00", expiresAt: "2026-07-13T01:05:00.000Z" });
  const finalized = repo.finalizeInbound({
    chatId: "oc-p2p",
    messageIds: ["om-1"],
    runKey: "2026-07-13:09:00",
    claimToken: claim.claimToken,
    polledThrough: "2026-07-13T01:00:00.000Z",
    summary: { messagesProcessed: 1 },
  });
  assert.deepEqual(repo.listPendingInbound("oc-p2p"), []);
  assert.equal(repo.getMessageCursor("oc-p2p").polledThrough, "2026-07-13T01:00:00.000Z");
  assert.equal(finalized.status, "completed");
  assert.deepEqual(finalized.summary, { messagesProcessed: 1 });
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM automation_runs WHERE status='running'").get().count, 0);
  db.close();
});

test("bounds pending inbound messages by the requested polling cutoff", () => {
  const db = openDatabase(":memory:");
  const repo = createAutomationRepository(db, { now: () => "2026-07-13T01:00:00.000Z" });
  repo.recordInbound([
    { messageId: "before", chatId: "oc-p2p", senderId: "owner", messageType: "text", content: { text: "a" }, createdAt: "2026-07-12T15:59:59.000Z" },
    { messageId: "boundary", chatId: "oc-p2p", senderId: "owner", messageType: "text", content: { text: "b" }, createdAt: "2026-07-12T16:00:00.000Z" },
    { messageId: "after", chatId: "oc-p2p", senderId: "owner", messageType: "text", content: { text: "c" }, createdAt: "2026-07-12T16:00:01.000Z" },
  ]);
  assert.deepEqual(repo.listPendingInbound("oc-p2p", { through: "2026-07-12T16:00:00.000Z" }).map((item) => item.messageId), ["before", "boundary"]);
  assert.deepEqual(repo.listPendingInbound("oc-p2p").map((item) => item.messageId), ["before", "boundary", "after"]);
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

test("rolls back message processing without advancing the cursor when finalization fails", () => {
  const db = openDatabase(":memory:");
  const repo = createAutomationRepository(db, { now: () => "2026-07-13T01:00:00.000Z" });
  const message = { messageId: "om-1", chatId: "oc-p2p", senderId: "ou-owner", messageType: "text", content: { text: "新增选题" }, createdAt: "2026-07-13T00:30:00.000Z" };
  repo.recordInbound([message]);
  const claim = repo.claimRun({ runKey: "run-1", workDate: "2026-07-13", node: "09:00", expiresAt: "2026-07-13T01:05:00.000Z" });
  assert.equal(repo.getMessageCursor("oc-p2p"), null);
  assert.throws(() => repo.finalizeInbound({
    chatId: "oc-p2p",
    messageIds: ["om-1", "om-missing"],
    runKey: "run-1",
    claimToken: claim.claimToken,
    polledThrough: "2026-07-13T01:00:00.000Z",
  }), /every pending inbound message/);
  assert.deepEqual(repo.listPendingInbound("oc-p2p").map((item) => item.messageId), ["om-1"]);
  assert.equal(repo.getMessageCursor("oc-p2p"), null);
  assert.equal(db.prepare("SELECT status FROM automation_runs WHERE run_key='run-1'").get().status, "running");
  db.close();
});

test("completed runs cannot be reclaimed while failed and expired runs can resume", () => {
  const db = openDatabase(":memory:");
  const clock = { value: "2026-07-13T01:00:00.000Z" };
  const repo = createAutomationRepository(db, { now: () => clock.value });
  const input = { runKey: "run-1", workDate: "2026-07-13", node: "09:00", expiresAt: "2026-07-13T01:05:00.000Z" };
  const firstClaim = repo.claimRun(input);
  assert.equal(firstClaim.claimed, true);
  assert.equal(repo.claimRun(input).claimed, false);
  repo.failRun("run-1", firstClaim.claimToken, "x".repeat(600));
  const resumedClaim = repo.claimRun(input);
  assert.equal(resumedClaim.claimed, true);
  repo.completeRun("run-1", resumedClaim.claimToken, { processed: 1 });
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
  const claim = repo.claimRun({ runKey: "run-1", workDate: "2026-07-13", node: "09:00", expiresAt: "2026-07-13T01:05:00.000Z" });
  repo.failRun("run-1", claim.claimToken, new Error("x".repeat(600)));
  assert.equal(db.prepare("SELECT length(error) AS size FROM automation_runs WHERE run_key='run-1'").get().size, 500);
  db.close();
});

test("redacts bearer credentials for direct repository callers", () => {
  const db = openDatabase(":memory:");
  const repo = createAutomationRepository(db, { now: () => "2026-07-13T01:00:00.000Z" });
  const claim = repo.claimRun({ runKey: "run-secret", workDate: "2026-07-13", node: "09:00", expiresAt: "2026-07-13T01:05:00.000Z" });
  repo.failRun("run-secret", claim.claimToken, new Error("Bearer super-secret"));
  const error = db.prepare("SELECT error FROM automation_runs WHERE run_key='run-secret'").get().error;
  assert.equal(error, "Bearer [redacted]");
  db.close();
});

test("rejects stale workers after an expired run is reclaimed", () => {
  const db = openDatabase(":memory:");
  const clock = { value: "2026-07-13T01:00:00.000Z" };
  let sequence = 0;
  const repo = createAutomationRepository(db, {
    now: () => clock.value,
    claimToken: () => `claim-${++sequence}`,
  });
  const input = { runKey: "run-1", workDate: "2026-07-13", node: "09:00", expiresAt: "2026-07-13T01:05:00.000Z" };
  const stale = repo.claimRun(input);
  clock.value = "2026-07-13T01:06:00.000Z";
  const current = repo.claimRun({ ...input, expiresAt: "2026-07-13T01:11:00.000Z" });
  assert.notEqual(stale.claimToken, current.claimToken);
  assert.equal(repo.completeRun("run-1", stale.claimToken, { stale: true }), null);
  assert.equal(repo.failRun("run-1", stale.claimToken, "stale failure"), null);
  const completed = repo.completeRun("run-1", current.claimToken, { stale: false });
  assert.equal(completed.status, "completed");
  assert.deepEqual(completed.summary, { stale: false });
  db.close();
});

test("a stale run claim cannot finalize inbound messages or advance the cursor", () => {
  const db = openDatabase(":memory:");
  const clock = { value: "2026-07-13T01:00:00.000Z" };
  let sequence = 0;
  const repo = createAutomationRepository(db, {
    now: () => clock.value,
    claimToken: () => `claim-${++sequence}`,
  });
  repo.recordInbound([{
    messageId: "om-1", chatId: "oc-p2p", senderId: "ou-owner", messageType: "text",
    content: { text: "新增选题" }, createdAt: "2026-07-13T00:30:00.000Z",
  }]);
  const input = { runKey: "run-1", workDate: "2026-07-13", node: "09:00", expiresAt: "2026-07-13T01:05:00.000Z" };
  const stale = repo.claimRun(input);
  clock.value = "2026-07-13T01:06:00.000Z";
  repo.claimRun({ ...input, expiresAt: "2026-07-13T01:11:00.000Z" });

  assert.throws(() => repo.finalizeInbound({
    chatId: "oc-p2p",
    messageIds: ["om-1"],
    runKey: "run-1",
    claimToken: stale.claimToken,
    polledThrough: "2026-07-13T01:06:00.000Z",
  }), /current running claim/);
  assert.deepEqual(repo.listPendingInbound("oc-p2p").map((item) => item.messageId), ["om-1"]);
  assert.equal(repo.getMessageCursor("oc-p2p"), null);
  db.close();
});

test("persists one fenced batch analysis across failed-run reclaim", () => {
  const db = openDatabase(":memory:");
  const clock = { value: "2026-07-13T01:00:00.000Z" };
  let sequence = 0;
  const repo = createAutomationRepository(db, { now: () => clock.value, claimToken: () => `claim-${++sequence}` });
  const input = { runKey: "run-analysis", workDate: "2026-07-13", node: "09:00", expiresAt: "2026-07-13T01:05:00.000Z" };
  const first = repo.claimRun(input);
  const analysis = { items: [{ messageIds: ["om-1"], disposition: "schedule_today" }] };
  const snapshot = { messageIds: ["om-1"], analysis };
  assert.deepEqual(repo.saveRunAnalysis("run-analysis", first.claimToken, snapshot), snapshot);
  repo.failRun("run-analysis", first.claimToken, new Error("after task create"));
  const resumed = repo.claimRun(input);
  assert.deepEqual(repo.loadRunAnalysis("run-analysis"), snapshot);
  assert.throws(() => repo.saveRunAnalysis("run-analysis", first.claimToken, { items: [] }), /current running claim/);
  assert.deepEqual(repo.saveRunAnalysis("run-analysis", resumed.claimToken, { messageIds: [], analysis: { items: [] } }), snapshot);
  db.close();
});

test("lists sent legacy task GUIDs and every managed Feishu link for cutover preflight", () => {
  const { db, repo } = fixture();
  const tasks = createTaskRepository(db);
  tasks.create({ id: "retained-ip", title: "retained" });
  repo.upsertFeishuLink({ localTaskId: "retained-ip", checkpointIndex: -1, taskGuid: "retained-parent" });
  db.prepare(`INSERT INTO outbox
    (id,kind,payload_json,idempotency_key,status,attempts,next_attempt_at,external_id,created_at,sent_at)
    VALUES ('sent','feishu_task_create','{}','sent-key','sent',0,'2026-07-13T00:00:00.000Z',
      'legacy-parent','2026-07-13T00:00:00.000Z','2026-07-13T00:00:01.000Z')`).run();
  db.prepare(`INSERT INTO outbox
    (id,kind,payload_json,idempotency_key,status,attempts,next_attempt_at,external_id,created_at)
    VALUES ('pending','feishu_task_create','{}','pending-key','pending',0,'2026-07-13T00:00:00.000Z',
      'not-sent','2026-07-13T00:00:00.000Z')`).run();

  assert.deepEqual(repo.listSentLegacyTaskGuids(), ["legacy-parent"]);
  assert.deepEqual(repo.listAllFeishuLinks().map((link) => [link.localTaskId, link.checkpointIndex]), [["retained-ip", -1]]);
  assert.equal(repo.localTaskExists("retained-ip"), true);
  assert.equal(repo.localTaskExists("missing-task"), false);
  db.close();
});

test("transactionally rebinds the exact retained tree and removes only the exact obsolete tree", () => {
  const { db, repo } = fixture();
  const tasks = createTaskRepository(db);
  for (const id of ["retained-ip", "obsolete-ip", "wk20260713-personal-ip"]) tasks.create({ id, title: id });
  const retained = treeLinks("retained-ip", "keep");
  const obsolete = treeLinks("obsolete-ip", "drop");
  for (const link of [...retained, ...obsolete]) repo.upsertFeishuLink(link);

  const result = repo.applyPersonalPlanLinkCutover({
    retainedLocalTaskId: "retained-ip",
    obsoleteLocalTaskId: "obsolete-ip",
    targetLocalTaskId: "wk20260713-personal-ip",
    retainedLinks: retained,
    obsoleteLinks: obsolete,
  });

  assert.deepEqual(result, { status: "applied", retainedLinks: 4, removedLinks: 4 });
  assert.equal(repo.listFeishuLinks("retained-ip").length, 0);
  assert.equal(repo.listFeishuLinks("obsolete-ip").length, 0);
  assert.deepEqual(
    repo.listFeishuLinks("wk20260713-personal-ip").map((link) => [link.checkpointIndex, link.taskGuid]),
    retained.map((link) => [link.checkpointIndex, link.taskGuid]),
  );
  assert.deepEqual(repo.applyPersonalPlanLinkCutover({
    retainedLocalTaskId: "retained-ip",
    obsoleteLocalTaskId: "obsolete-ip",
    targetLocalTaskId: "wk20260713-personal-ip",
    retainedLinks: retained,
    obsoleteLinks: obsolete,
  }), { status: "already_applied", retainedLinks: 4, removedLinks: 0 });
  db.close();
});

test("link cutover rejects a changed identity without mutating either tree", () => {
  const { db, repo } = fixture();
  const tasks = createTaskRepository(db);
  for (const id of ["retained-ip", "obsolete-ip", "wk20260713-personal-ip"]) tasks.create({ id, title: id });
  const retained = treeLinks("retained-ip", "keep");
  const obsolete = treeLinks("obsolete-ip", "drop");
  for (const link of [...retained, ...obsolete]) repo.upsertFeishuLink(link);
  const changed = obsolete.map((link) => link.checkpointIndex === 1 ? { ...link, taskGuid: "unexpected-child" } : link);

  assert.throws(() => repo.applyPersonalPlanLinkCutover({
    retainedLocalTaskId: "retained-ip",
    obsoleteLocalTaskId: "obsolete-ip",
    targetLocalTaskId: "wk20260713-personal-ip",
    retainedLinks: retained,
    obsoleteLinks: changed,
  }), /link identity changed/);
  assert.equal(repo.listFeishuLinks("retained-ip").length, 4);
  assert.equal(repo.listFeishuLinks("obsolete-ip").length, 4);
  assert.equal(repo.listFeishuLinks("wk20260713-personal-ip").length, 0);
  db.close();
});

function treeLinks(localTaskId, prefix) {
  const parentGuid = `${prefix}-parent`;
  return [-1, 0, 1, 2].map((checkpointIndex) => ({
    localTaskId,
    checkpointIndex,
    taskGuid: checkpointIndex === -1 ? parentGuid : `${prefix}-child-${checkpointIndex}`,
    parentGuid: checkpointIndex === -1 ? null : parentGuid,
    snapshotHash: `${prefix}-${checkpointIndex}`,
  }));
}
