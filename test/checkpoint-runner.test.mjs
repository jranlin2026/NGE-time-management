import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createCheckpointRunner } from "../src/lib/checkpoint-runner.mjs";
import { openDatabase } from "../src/db/database.mjs";
import { createOperationsRepository } from "../src/db/operations-repository.mjs";
import { createOutboxWorker } from "../src/lib/outbox-worker.mjs";

test("commits messages only after sync and reply queueing succeed", async () => {
  const fixture = runnerFixture({ messages: [message("om-1", "新增一个选题")] });
  const result = await fixture.runner.run({ now: "2026-07-13T09:00:00+08:00", forcedNode: "09:00" });
  assert.equal(result.status, "completed");
  assert.deepEqual(fixture.pending, []);
  assert.equal(fixture.outbox.filter((item) => item.kind === "private_checkpoint_summary").length, 1);
  assert.ok(fixture.calls.indexOf("push") < fixture.calls.indexOf("enqueue"));
  assert.ok(fixture.calls.indexOf("flush") < fixture.calls.indexOf("finalize"));
});

test("leaves messages and cursor pending when task sync fails", async () => {
  const fixture = runnerFixture({ messages: [message("om-1", "今天要修客户模块")], syncError: new Error("task api unavailable") });
  await assert.rejects(() => fixture.runner.run({ now: "2026-07-13T09:00:00+08:00", forcedNode: "09:00" }), /task api unavailable/);
  assert.deepEqual(fixture.pending.map((item) => item.messageId), ["om-1"]);
  assert.equal(fixture.cursor, null);
  assert.deepEqual(fixture.calls.slice(-2), ["fail", "unlock"]);
});

test("queues no reply for a quiet healthy 15:00 run", async () => {
  const fixture = runnerFixture({ messages: [], healthyProgress: true });
  const result = await fixture.runner.run({ now: "2026-07-13T15:00:00+08:00", forcedNode: "15:00" });
  assert.equal(result.repliesQueued, 0);
  assert.equal(fixture.outbox.length, 0);
});

test("an overlapping runner performs no writes", async () => {
  const fixture = runnerFixture({ lockHeld: true });
  const result = await fixture.runner.run({ now: "2026-07-13T18:00:00+08:00" });
  assert.deepEqual(result, { status: "skipped", reason: "lock_held" });
  assert.deepEqual(fixture.calls, ["lock"]);
});

test("dry run performs no writes", async () => {
  const fixture = runnerFixture({ messages: [message("om-1", "新增任务")] });
  const result = await fixture.runner.run({ now: "2026-07-13T09:00:00+08:00", forcedNode: "09:00", dryRun: true });
  assert.equal(result.status, "dry_run");
  assert.deepEqual(fixture.calls, []);
  assert.equal(fixture.outbox.length, 0);
});

test("refuses to queue a private summary without the owner open_id", async () => {
  const fixture = runnerFixture({ messages: [message("om-1", "新增任务")], managerUserId: "" });
  await assert.rejects(() => fixture.runner.run({ now: "2026-07-13T09:00:00+08:00", forcedNode: "09:00" }), /owner open_id/);
  assert.equal(fixture.outbox.length, 0);
  assert.deepEqual(fixture.pending.map((item) => item.messageId), ["om-1"]);
});

test("does not finalize when strict private summary delivery is deferred for retry", async () => {
  const fixture = runnerFixture({ messages: [message("om-1", "新增任务")] });
  const db = openDatabase(":memory:");
  const ops = createOperationsRepository(db, { now: () => "2026-07-13T01:00:00.000Z", id: () => "outbox-1" });
  const worker = createOutboxWorker({
    ops,
    clock: { now: () => new Date("2026-07-13T01:00:00.000Z") },
    send: async () => { throw new Error("delivery unavailable"); },
  });
  fixture.setDelivery({ ops, outboxWorker: worker });

  await assert.rejects(() => fixture.runner.run({ now: "2026-07-13T09:00:00+08:00", forcedNode: "09:00" }), /delivery unavailable/);
  assert.deepEqual(fixture.pending.map((item) => item.messageId), ["om-1"]);
  assert.equal(fixture.cursor, null);
  assert.equal(ops.listOutbox()[0].attempts, 1);
  assert.equal(ops.listOutbox()[0].status, "pending");
  db.close();
});

test("applies remote progress before analyzer reads local context", async () => {
  let localCompleted = false;
  const fixture = runnerFixture({
    messages: [message("om-1", "进度如何")],
    reconcileRemoteProgress: async () => { localCompleted = true; return { actions: [{ type: "checkpoint_completed" }], replyParts: ["进度已同步"], changed: true }; },
    buildAnalysisContext: () => ({ localCompleted }),
    analyze: async ({ context }) => {
      assert.equal(localCompleted, true);
      assert.equal(context.localCompleted, true);
      return { items: [] };
    },
  });
  await fixture.runner.run({ now: "2026-07-13T15:00:00+08:00", forcedNode: "15:00" });
});

test("historical logical time still claims a lease from the execution clock", async () => {
  let lease;
  const fixture = runnerFixture({
    executionNow: new Date("2026-07-12T10:00:00.000Z"),
    onClaimLock: (input) => { lease = input; },
  });
  await fixture.runner.run({ now: "2020-01-01T09:00:00+08:00", forcedNode: "09:00" });
  assert.equal(lease.expiresAt, "2026-07-12T10:05:00.000Z");
});

test("CLI dry-run does not create or migrate the configured database", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "checkpoint-dry-run-"));
  const dbPath = path.join(directory, "missing", "runtime.sqlite");
  const result = spawnSync(process.execPath, ["scripts/run-checkpoint.mjs", "--dry-run", "--now=2026-07-13T09:00:00+08:00"], {
    cwd: path.resolve(import.meta.dirname, ".."),
    encoding: "utf8",
    env: { ...process.env, TIME_MASTER_DB_PATH: dbPath, FEISHU_P2P_CHAT_ID: "oc-direct", FEISHU_APP_ID: "", FEISHU_APP_SECRET: "" },
  });
  assert.equal(fs.existsSync(dbPath), false);
  assert.equal(result.stdout.trim().split("\n").length, 1);
});

test("CLI JSON never exposes a bare bearer credential", () => {
  const result = spawnSync(process.execPath, ["scripts/run-checkpoint.mjs", "--bad=Bearer super-secret"], { cwd: path.resolve(import.meta.dirname, ".."), encoding: "utf8" });
  assert.doesNotMatch(result.stdout, /super-secret/);
  assert.match(result.stdout, /\[redacted\]/);
});

function runnerFixture({ messages = [], syncError = null, healthyProgress = false, lockHeld = false, managerUserId = "ou-owner", reconcileRemoteProgress, buildAnalysisContext, analyze, executionNow, onClaimLock } = {}) {
  const calls = [];
  const outbox = [];
  const pending = [];
  let cursor = null;
  const runtime = {
    claimLock: (input) => { calls.push("lock"); onClaimLock?.(input); return !lockHeld; },
    releaseLock: () => { calls.push("unlock"); },
    claimRun: () => { calls.push("claim"); return { claimed: true, claimToken: "claim-1" }; },
    failRun: () => { calls.push("fail"); },
    completeRun: () => { calls.push("complete"); },
    getMessageCursor: () => cursor,
    recordInbound: (items) => { calls.push("record"); pending.push(...items.filter((item) => !pending.some((old) => old.messageId === item.messageId))); },
    listPendingInbound: () => pending,
    finalizeInbound: ({ messageIds, polledThrough, claimToken }) => {
      calls.push("finalize");
      assert.equal(claimToken, "claim-1");
      pending.splice(0, pending.length, ...pending.filter((item) => !messageIds.includes(item.messageId)));
      cursor = polledThrough;
    },
  };
  const deps = {
    config: { timezone: "Asia/Shanghai", managerUserId, scheduleVersion: 2 },
    runtime,
    resolveChatId: async () => "oc-p2p",
    pollMessages: async () => messages,
    taskSync: {
      pullProgress: async () => ({ completedTasks: [], completedCheckpoints: healthyProgress ? [{ localTaskId: "done", checkpointIndex: 0 }] : [] }),
      pushSchedule: async () => { calls.push("push"); if (syncError) throw syncError; return { tasks: [] }; },
    },
    analyzer: { analyzeCheckpointMessages: analyze || (async () => ({ items: messages.map((item) => ({ messageIds: [item.messageId] })) })) },
    policy: {
      reconcileRemoteProgress: reconcileRemoteProgress || (async () => ({ actions: [], replyParts: [], changed: false })),
      apply: async () => ({ replyRequired: messages.length > 0, reply: messages.length ? "已合并处理" : "", actions: [], schedule: { version: 3, blocks: [] } }),
    },
    ops: { enqueueOutbox: (item) => { calls.push("enqueue"); outbox.push(item); return item; } },
    outboxWorker: { flush: async () => { calls.push("flush"); } },
    getCompletedNodes: () => [],
    owner: () => "runner-1",
    clock: executionNow ? { now: () => executionNow } : undefined,
    buildAnalysisContext,
  };
  let runner = createCheckpointRunner(deps);
  return {
    get runner() { return runner; }, runtime, calls, outbox, pending, get cursor() { return cursor; },
    setDelivery(overrides) { Object.assign(deps, overrides); runner = createCheckpointRunner(deps); },
  };
}

function message(messageId, text) {
  return { messageId, chatId: "oc-p2p", senderId: "ou-owner", messageType: "text", content: { text }, createdAt: "2026-07-13T00:30:00.000Z" };
}
