import assert from "node:assert/strict";
import test from "node:test";
import { createCheckpointRunner } from "../src/lib/checkpoint-runner.mjs";

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

function runnerFixture({ messages = [], syncError = null, healthyProgress = false, lockHeld = false, managerUserId = "ou-owner" } = {}) {
  const calls = [];
  const outbox = [];
  const pending = [];
  let cursor = null;
  const runtime = {
    claimLock: () => { calls.push("lock"); return !lockHeld; },
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
  const runner = createCheckpointRunner({
    config: { timezone: "Asia/Shanghai", managerUserId, scheduleVersion: 2 },
    runtime,
    resolveChatId: async () => "oc-p2p",
    pollMessages: async () => messages,
    taskSync: {
      pullProgress: async () => ({ completedTasks: [], completedCheckpoints: healthyProgress ? [{ localTaskId: "done", checkpointIndex: 0 }] : [] }),
      pushSchedule: async () => { calls.push("push"); if (syncError) throw syncError; return { tasks: [] }; },
    },
    analyzer: { analyzeCheckpointMessages: async () => ({ items: messages.map((item) => ({ messageIds: [item.messageId] })) }) },
    policy: { apply: async () => ({ replyRequired: messages.length > 0, reply: messages.length ? "已合并处理" : "", actions: [], schedule: { version: 3, blocks: [] } }) },
    ops: { enqueueOutbox: (item) => { calls.push("enqueue"); outbox.push(item); return item; } },
    outboxWorker: { flush: async () => { calls.push("flush"); } },
    getCompletedNodes: () => [],
    owner: () => "runner-1",
  });
  return { runner, runtime, calls, outbox, pending, get cursor() { return cursor; } };
}

function message(messageId, text) {
  return { messageId, chatId: "oc-p2p", senderId: "ou-owner", messageType: "text", content: { text }, createdAt: "2026-07-13T00:30:00.000Z" };
}
