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

test("reconciles stranded project writes once before node processing", async () => {
  let reconciliations = 0;
  const fixture = runnerFixture({ reconcileProjectWrites: async () => { reconciliations += 1; } });
  await fixture.runner.run({ now: "2026-07-13T09:00:00+08:00", forcedNode: "09:00" });
  assert.equal(reconciliations, 1);
  assert.ok(fixture.calls.indexOf("reconcile-projects") < fixture.calls.indexOf("claim"));
});

test("failed-run retry reuses persisted analysis despite analyzer reorder and regroup", async () => {
  let analyzerCalls = 0;
  let failPush = true;
  const created = new Set();
  const fixture = runnerFixture({
    messages: [message("om-1", "任务一"), message("om-2", "任务二")],
    persistAnalysis: true,
    analyze: async () => {
      analyzerCalls += 1;
      return analyzerCalls === 1
        ? { items: [{ messageIds: ["om-1"], disposition: "schedule_today" }, { messageIds: ["om-2"], disposition: "schedule_today" }] }
        : { items: [{ messageIds: ["om-2", "om-1"], disposition: "schedule_today" }] };
    },
    applyPolicy: async ({ analysis }) => {
      for (const item of analysis.items) created.add([...item.messageIds].sort().join("+"));
      return { replyRequired: false, reply: "", actions: [], schedule: { version: 1, blocks: [] } };
    },
    pushSchedule: async () => { if (failPush) { failPush = false; throw new Error("after local creation"); } },
  });
  await assert.rejects(fixture.runner.run({ now: "2026-07-13T09:00:00+08:00", forcedNode: "09:00" }), /after local creation/);
  await fixture.runner.run({ now: "2026-07-13T09:00:00+08:00", forcedNode: "09:00" });
  assert.equal(analyzerCalls, 1);
  assert.deepEqual([...created].sort(), ["om-1", "om-2"]);
});

test("retry processes only persisted analysis message ids and leaves newly revealed input for next node", async () => {
  let pollCall = 0;
  let analyzerCalls = 0;
  let failPush = true;
  const analyzed = [];
  const fixture = runnerFixture({
    persistAnalysis: true,
    pollMessages: () => {
      pollCall += 1;
      if (pollCall === 1) return [message("om-a", "A")];
      if (pollCall === 2) return [message("om-a", "A"), message("om-b", "B")];
      return [];
    },
    analyze: async ({ node, messages }) => {
      analyzerCalls += 1;
      analyzed.push({ node, ids: messages.map((item) => item.messageId) });
      return { items: messages.map((item) => ({ messageIds: [item.messageId], disposition: "candidate_pool" })) };
    },
    pushSchedule: async () => { if (failPush) { failPush = false; throw new Error("after analysis A"); } },
  });
  await assert.rejects(fixture.runner.run({ now: "2026-07-13T09:00:00+08:00", forcedNode: "09:00" }), /after analysis A/);
  await fixture.runner.run({ now: "2026-07-13T09:00:00+08:00", forcedNode: "09:00" });
  assert.equal(analyzerCalls, 1);
  assert.deepEqual(fixture.pending.map((item) => item.messageId), ["om-b"]);
  await fixture.runner.run({ now: "2026-07-13T12:00:00+08:00", forcedNode: "12:00" });
  assert.equal(analyzerCalls, 2);
  assert.deepEqual(analyzed, [{ node: "09:00", ids: ["om-a"] }, { node: "12:00", ids: ["om-b"] }]);
  assert.deepEqual(fixture.pending, []);
});

test("legacy analysis snapshot derives its batch from item message ids, never all pending", async () => {
  const fixture = runnerFixture({
    persistAnalysis: true,
    pendingMessages: [message("om-a", "A"), message("om-b", "B")],
    analyze: async () => assert.fail("legacy snapshot must be reused"),
  });
  fixture.runtime.saveRunAnalysis("2026-07-13:09:00", "legacy", {
    items: [{ messageIds: ["om-a"], disposition: "candidate_pool" }],
  });
  await fixture.runner.run({ now: "2026-07-13T09:00:00+08:00", forcedNode: "09:00" });
  assert.deepEqual(fixture.pending.map((item) => item.messageId), ["om-b"]);
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

test("persists batch analysis before applying remote progress side effects", async () => {
  const order = [];
  const fixture = runnerFixture({
    messages: [message("om-1", "进度如何")],
    persistAnalysis: true,
    reconcileRemoteProgress: async () => { order.push("reconcile"); return { actions: [{ type: "checkpoint_completed" }], replyParts: ["进度已同步"], changed: true }; },
    analyze: async ({ context }) => { order.push("analyze"); assert.ok(context.remoteProgress); return { items: [] }; },
  });
  await fixture.runner.run({ now: "2026-07-13T15:00:00+08:00", forcedNode: "15:00" });
  assert.deepEqual(order, ["analyze", "reconcile"]);
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

test("CLI dry-run rejects a misspelled checkpoint node", () => {
  const result = spawnSync(process.execPath, ["scripts/run-checkpoint.mjs", "--dry-run", "--node=09:O0"], {
    cwd: path.resolve(import.meta.dirname, ".."), encoding: "utf8",
    env: { ...process.env, FEISHU_P2P_CHAT_ID: "oc-direct", FEISHU_APP_ID: "", FEISHU_APP_SECRET: "" },
  });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /unsupported checkpoint node/);
});

test("CLI JSON never exposes a bare bearer credential", () => {
  const result = spawnSync(process.execPath, ["scripts/run-checkpoint.mjs", "--bad=Bearer super-secret"], { cwd: path.resolve(import.meta.dirname, ".."), encoding: "utf8" });
  assert.doesNotMatch(result.stdout, /super-secret/);
  assert.match(result.stdout, /\[redacted\]/);
});

test("unforced 09 locks before due lookup and does not repeat a completed prior review", async () => {
  const fixture = runnerFixture({ completedNodes: ["2026-07-12:24:00"] });
  const result = await fixture.runner.run({ now: "2026-07-13T09:00:00+08:00" });
  assert.deepEqual(fixture.calls.slice(0, 2), ["lock", "completed"]);
  assert.deepEqual(result.nodes, ["08:00", "09:00"]);
  assert.deepEqual(fixture.claims.map(({ runKey, workDate }) => [runKey, workDate]), [
    ["2026-07-13:08:00", "2026-07-13"],
    ["2026-07-13:09:00", "2026-07-13"],
  ]);
  assert.deepEqual(fixture.polls.map((input) => input.endTime), ["2026-07-13T00:00:00.000Z", "2026-07-13T01:00:00.000Z"].map((value) => Date.parse(value) / 1000));
});

test("unforced 09 executes prior review, 08 prerequisite, and current node as separate intervals", async () => {
  const source = [
    messageAt("om-review", "昨晚收尾", "2026-07-12T15:50:00.000Z"),
    messageAt("om-morning", "今早任务", "2026-07-12T23:00:00.000Z"),
    messageAt("om-nine", "九点校准", "2026-07-13T00:30:00.000Z"),
  ];
  const analyzed = [];
  const fixture = runnerFixture({
    completedNodes: [],
    pollMessages: ({ startTime, endTime }) => source.filter((item) => {
      const seconds = Date.parse(item.createdAt) / 1000;
      return seconds > (startTime ?? -Infinity) && seconds <= endTime;
    }),
    analyze: async ({ node, workDate, messages }) => {
      analyzed.push({ node, workDate, ids: messages.map((item) => item.messageId) });
      return { items: [] };
    },
  });
  await fixture.runner.run({ now: "2026-07-13T09:00:00+08:00" });
  assert.deepEqual(fixture.claims.map(({ runKey }) => runKey), ["2026-07-12:24:00", "2026-07-13:08:00", "2026-07-13:09:00"]);
  assert.deepEqual(fixture.polls.map((input) => input.endTime), [
    "2026-07-12T16:00:00.000Z", "2026-07-13T00:00:00.000Z", "2026-07-13T01:00:00.000Z",
  ].map((value) => Date.parse(value) / 1000));
  assert.deepEqual(analyzed, [
    { node: "24:00", workDate: "2026-07-12", ids: ["om-review"] },
    { node: "08:00", workDate: "2026-07-13", ids: ["om-morning"] },
    { node: "09:00", workDate: "2026-07-13", ids: ["om-nine"] },
  ]);
});

test("pre-recorded pending messages remain isolated by each catch-up cutoff", async () => {
  const analyzed = [];
  const fixture = runnerFixture({
    pendingMessages: [
      messageAt("om-review", "昨晚收尾", "2026-07-12T15:50:00.000Z"),
      messageAt("om-morning", "今早任务", "2026-07-12T23:00:00.000Z"),
      messageAt("om-nine", "九点校准", "2026-07-13T00:30:00.000Z"),
    ],
    pollMessages: () => [],
    analyze: async ({ node, messages }) => {
      analyzed.push([node, messages.map((item) => item.messageId)]);
      return { items: [] };
    },
  });
  const result = await fixture.runner.run({ now: "2026-07-13T09:00:00+08:00" });
  assert.deepEqual(analyzed, [
    ["24:00", ["om-review"]],
    ["08:00", ["om-morning"]],
    ["09:00", ["om-nine"]],
  ]);
  assert.equal(result.messagesProcessed, 3);
  assert.deepEqual(fixture.finalizedThrough, ["2026-07-12T16:00:00.000Z", "2026-07-13T00:00:00.000Z", "2026-07-13T01:00:00.000Z"]);
});

function runnerFixture({ messages = [], pendingMessages = [], pollMessages, completedNodes = [], syncError = null, healthyProgress = false, lockHeld = false, managerUserId = "ou-owner", reconcileRemoteProgress, reconcileProjectWrites, buildAnalysisContext, analyze, applyPolicy, pushSchedule, persistAnalysis = false, executionNow, onClaimLock } = {}) {
  const calls = [];
  const claims = [];
  const polls = [];
  const outbox = [];
  const pending = [...pendingMessages];
  const finalizedThrough = [];
  let cursor = null;
  const savedAnalyses = new Map();
  const runtime = {
    claimLock: (input) => { calls.push("lock"); onClaimLock?.(input); return !lockHeld; },
    releaseLock: () => { calls.push("unlock"); },
    claimRun: (input) => { calls.push("claim"); claims.push(input); return { claimed: true, claimToken: "claim-1" }; },
    failRun: () => { calls.push("fail"); },
    completeRun: () => { calls.push("complete"); },
    loadRunAnalysis: persistAnalysis ? (runKey) => savedAnalyses.get(runKey) || null : undefined,
    saveRunAnalysis: persistAnalysis ? (runKey, _claimToken, analysis) => {
      calls.push("save-analysis");
      if (!savedAnalyses.has(runKey)) savedAnalyses.set(runKey, analysis);
      return savedAnalyses.get(runKey);
    } : undefined,
    getMessageCursor: () => cursor ? { polledThrough: cursor } : null,
    recordInbound: (items) => { calls.push("record"); pending.push(...items.filter((item) => !pending.some((old) => old.messageId === item.messageId))); },
    listPendingInbound: (_chatId, options = {}) => options.through
      ? pending.filter((item) => item.createdAt <= options.through)
      : pending,
    finalizeInbound: ({ messageIds, polledThrough, claimToken }) => {
      calls.push("finalize");
      finalizedThrough.push(polledThrough);
      assert.equal(claimToken, "claim-1");
      pending.splice(0, pending.length, ...pending.filter((item) => !messageIds.includes(item.messageId)));
      cursor = polledThrough;
    },
  };
  const deps = {
    config: { timezone: "Asia/Shanghai", managerUserId, scheduleVersion: 2 },
    runtime,
    resolveChatId: async () => "oc-p2p",
    pollMessages: async (input) => { polls.push(input); return pollMessages ? pollMessages(input) : messages; },
    taskSync: {
      pullProgress: async () => ({ completedTasks: [], completedCheckpoints: healthyProgress ? [{ localTaskId: "done", checkpointIndex: 0 }] : [] }),
      pushSchedule: async () => { calls.push("push"); if (pushSchedule) return pushSchedule(); if (syncError) throw syncError; return { tasks: [] }; },
    },
    analyzer: { analyzeCheckpointMessages: analyze || (async () => ({ items: messages.map((item) => ({ messageIds: [item.messageId] })) })) },
    policy: {
      reconcileRemoteProgress: reconcileRemoteProgress || (async () => ({ actions: [], replyParts: [], changed: false })),
      apply: applyPolicy || (async () => ({ replyRequired: messages.length > 0, reply: messages.length ? "已合并处理" : "", actions: [], schedule: { version: 3, blocks: [] } })),
    },
    ops: { enqueueOutbox: (item) => { calls.push("enqueue"); outbox.push(item); return item; } },
    outboxWorker: { flush: async () => { calls.push("flush"); } },
    getCompletedNodes: () => { calls.push("completed"); return completedNodes; },
    owner: () => "runner-1",
    clock: executionNow ? { now: () => executionNow } : undefined,
    buildAnalysisContext,
    reconcileProjectWrites: reconcileProjectWrites ? async () => { calls.push("reconcile-projects"); return reconcileProjectWrites(); } : undefined,
  };
  let runner = createCheckpointRunner(deps);
  return {
    get runner() { return runner; }, runtime, calls, claims, polls, finalizedThrough, outbox, pending, get cursor() { return cursor; },
    setDelivery(overrides) { Object.assign(deps, overrides); runner = createCheckpointRunner(deps); },
  };
}

function message(messageId, text) {
  return { messageId, chatId: "oc-p2p", senderId: "ou-owner", messageType: "text", content: { text }, createdAt: "2026-07-13T00:30:00.000Z" };
}

function messageAt(messageId, text, createdAt) {
  return { ...message(messageId, text), createdAt };
}
