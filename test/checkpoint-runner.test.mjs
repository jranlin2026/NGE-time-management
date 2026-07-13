import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createCheckpointRunner, normalizeMessageTime } from "../src/lib/checkpoint-runner.mjs";
import { openDatabase, withTransaction } from "../src/db/database.mjs";
import { createTaskRepository } from "../src/db/task-repository.mjs";
import { createOperationsRepository } from "../src/db/operations-repository.mjs";
import { createAutomationRepository } from "../src/db/automation-repository.mjs";
import { createOutboxWorker } from "../src/lib/outbox-worker.mjs";
import { createManagerService } from "../src/lib/manager-service.mjs";
import { createCheckpointPolicy } from "../src/lib/checkpoint-policy.mjs";
import { createReminderEngine } from "../src/lib/reminder-engine.mjs";

test("commits messages only after sync and reply queueing succeed", async () => {
  const fixture = runnerFixture({ messages: [message("om-1", "新增一个选题")] });
  const result = await fixture.runner.run({ now: "2026-07-13T09:00:00+08:00", forcedNode: "09:00" });
  assert.equal(result.status, "completed");
  assert.deepEqual(fixture.pending, []);
  assert.equal(fixture.outbox.filter((item) => item.kind === "private_checkpoint_summary").length, 1);
  assert.ok(fixture.calls.indexOf("push") < fixture.calls.indexOf("enqueue"));
  assert.ok(fixture.calls.indexOf("flush") < fixture.calls.indexOf("finalize"));
});

test("normalizes Feishu millisecond timestamps without moving messages into the far future", () => {
  assert.equal(normalizeMessageTime("1783902600000"), "2026-07-13T00:30:00.000Z");
  assert.equal(normalizeMessageTime("1783902600"), "2026-07-13T00:30:00.000Z");
});

test("leaves messages and cursor pending when task sync fails", async () => {
  const fixture = runnerFixture({ messages: [message("om-1", "今天要修客户模块")], syncError: new Error("task api unavailable") });
  await assert.rejects(() => fixture.runner.run({ now: "2026-07-13T09:00:00+08:00", forcedNode: "09:00" }), /task api unavailable/);
  assert.deepEqual(fixture.pending.map((item) => item.messageId), ["om-1"]);
  assert.equal(fixture.cursor, null);
  assert.deepEqual(fixture.calls.slice(-2), ["fail", "unlock"]);
});

test("task sync failure sends one private warning and keeps the run failed", async () => {
  const fixture = runnerFixture({ syncError: new Error("task api unavailable") });

  await assert.rejects(
    () => fixture.runner.run({ now: "2026-07-13T12:00:00+08:00", forcedNode: "12:00" }),
    /task api unavailable/,
  );

  const warnings = fixture.outbox.filter((row) => row.idempotencyKey === "private-sync-failure:2026-07-13:12:00");
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].kind, "private_checkpoint_summary");
  assert.equal(warnings[0].payload.text, "飞书任务这一下没同步上，先别照着旧任务跑。\n我正在重试；同步好后会直接告诉你下一步做什么。");
  assert.equal(fixture.runStatuses.get("2026-07-13:12:00"), "failed");
});

test("queues no reply for a quiet healthy 15:00 run", async () => {
  const fixture = runnerFixture({ messages: [], healthyProgress: true });
  const result = await fixture.runner.run({ now: "2026-07-13T15:00:00+08:00", forcedNode: "15:00" });
  assert.equal(result.repliesQueued, 0);
  assert.equal(fixture.outbox.length, 0);
});

test("uses the invocation instant for catch-up scheduling while preserving message cutoffs", async () => {
  const reconciliationInputs = [];
  const policyInputs = [];
  const fixture = runnerFixture({
    completedNodes: ["2026-07-12:24:00"],
    reconcileRemoteProgress: async (input) => {
      reconciliationInputs.push(input);
      return { actions: [], replyParts: [], changed: false };
    },
    applyPolicy: async (input) => {
      policyInputs.push(input);
      return { replyRequired: false, reply: "", actions: [], schedule: { version: 1, blocks: [] } };
    },
  });

  await fixture.runner.run({ now: "2026-07-13T09:00:00+08:00" });

  assert.deepEqual(fixture.polls.map((input) => input.endTime), [
    "2026-07-13T00:00:00.000Z",
    "2026-07-13T01:00:00.000Z",
  ].map((value) => Date.parse(value) / 1000));
  assert.deepEqual(reconciliationInputs.map(({ node, now }) => [node, now]), [
    ["08:00", "2026-07-13T01:00:00.000Z"],
    ["09:00", "2026-07-13T01:00:00.000Z"],
  ]);
  assert.deepEqual(policyInputs.map(({ node, now }) => [node, now]), [
    ["08:00", "2026-07-13T01:00:00.000Z"],
    ["09:00", "2026-07-13T01:00:00.000Z"],
  ]);
});

test("continues today's node when a missed prior review is already behind the message cursor", async () => {
  const fixture = runnerFixture({
    completedNodes: ["08:00"],
    initialCursor: "2026-07-13T05:14:42.000Z",
    pollMessages: ({ startTime, endTime }) => {
      assert.ok(startTime === undefined || startTime <= endTime, "must never ask Feishu for an inverted time range");
      return [];
    },
  });

  const result = await fixture.runner.run({ now: "2026-07-13T15:00:00+08:00" });

  assert.deepEqual(result.nodes, ["24:00", "15:00"]);
  assert.equal(fixture.polls.length, 1);
  assert.equal(fixture.polls[0].endTime, Date.parse("2026-07-13T07:00:00.000Z") / 1000);
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

test("controlled replay requires a forced node and never echoes a rejected token", async () => {
  const missingNode = runnerFixture();
  await assert.rejects(
    () => missingNode.runner.run({ now: "2026-07-13T08:30:00+08:00", replayToken: "morning-fix" }),
    /replay token requires forced checkpoint node/,
  );
  assert.deepEqual(missingNode.calls, []);

  const rejected = "Morning-Fix-SECRET";
  const invalidToken = runnerFixture();
  await assert.rejects(
    () => invalidToken.runner.run({ now: "2026-07-13T08:30:00+08:00", forcedNode: "08:00", replayToken: rejected }),
    (error) => {
      assert.match(error.message, /invalid replay token/);
      assert.doesNotMatch(error.message, new RegExp(rejected));
      return true;
    },
  );
  assert.deepEqual(invalidToken.calls, []);
});

test("ordinary forced runs retain their original run and private-summary keys", async () => {
  const fixture = runnerFixture({ messages: [message("om-ordinary", "按原计划执行")] });
  await fixture.runner.run({ now: "2026-07-13T09:00:00+08:00", forcedNode: "09:00" });

  assert.equal(fixture.claims[0].runKey, "2026-07-13:09:00");
  assert.equal(fixture.outbox[0].idempotencyKey, `private-summary:2026-07-13:09:00:3:${digestMessages([message("om-ordinary", "按原计划执行")])}`);
});

test("controlled replay uses distinct run and private-summary keys without changing the ordinary completed row", async () => {
  const fixture = runnerFixture({
    messages: [messageAt("om-replay", "重新发送完整执行令", "2026-07-13T00:15:00.000Z")],
    initialRunStatuses: [["2026-07-13:08:00", "completed"]],
    idempotentRuns: true,
  });

  await fixture.runner.run({
    now: "2026-07-13T08:30:00+08:00",
    forcedNode: "08:00",
    replayToken: "brief-v2",
  });

  assert.equal(fixture.claims[0].runKey, "2026-07-13:08:00:replay:brief-v2");
  assert.equal(fixture.runStatuses.get("2026-07-13:08:00"), "completed");
  assert.equal(fixture.runStatuses.get("2026-07-13:08:00:replay:brief-v2"), "completed");
  assert.equal(fixture.outbox[0].idempotencyKey, "private-summary:2026-07-13:08:00:replay:brief-v2");
});

test("the same controlled replay token claims once and creates no second sync or DM", async () => {
  const fixture = runnerFixture({
    messages: [messageAt("om-replay", "重新发送完整执行令", "2026-07-13T00:15:00.000Z")],
    idempotentRuns: true,
  });
  const input = {
    now: "2026-07-13T08:30:00+08:00",
    forcedNode: "08:00",
    replayToken: "brief-v2",
  };

  await fixture.runner.run(input);
  const firstPushes = fixture.calls.filter((call) => call === "push").length;
  const firstReplies = fixture.outbox.length;
  await fixture.runner.run(input);

  assert.equal(fixture.successfulClaims.filter((runKey) => runKey === "2026-07-13:08:00:replay:brief-v2").length, 1);
  assert.equal(fixture.calls.filter((call) => call === "push").length, firstPushes);
  assert.equal(fixture.outbox.length, firstReplies);
});

test("controlled replay retry delivers one private summary when finalize fails and plan inputs change", async () => {
  const first = messageAt("om-replay-a", "重新发送执行令", "2026-07-13T00:15:00.000Z");
  const second = messageAt("om-replay-b", "增加一项工作", "2026-07-13T00:20:00.000Z");
  let pollCall = 0;
  let scheduleVersion = 3;
  let deliveries = 0;
  const fixture = runnerFixture({
    pollMessages: () => (++pollCall === 1 ? [first] : [first, second]),
    finalizeErrorOnce: true,
    analyze: async ({ messages }) => ({
      items: messages.map((item) => ({ messageIds: [item.messageId], disposition: "candidate_pool" })),
    }),
    applyPolicy: async () => ({
      replyRequired: true,
      reply: "同一执行令",
      actions: [],
      schedule: { version: scheduleVersion++, blocks: [] },
    }),
  });
  const db = openDatabase(":memory:");
  const ops = createOperationsRepository(db, { now: () => "2026-07-13T00:30:00.000Z" });
  const worker = createOutboxWorker({
    ops,
    clock: { now: () => new Date("2026-07-13T00:30:00.000Z") },
    send: async () => { deliveries += 1; return {}; },
  });
  fixture.setDelivery({ ops, outboxWorker: worker });
  const input = {
    now: "2026-07-13T08:30:00+08:00",
    forcedNode: "08:00",
    replayToken: "brief-v2",
  };

  try {
    await assert.rejects(fixture.runner.run(input), /before atomic finalize/);
    await fixture.runner.run(input);

    assert.equal(deliveries, 1);
    assert.equal(ops.listOutbox().length, 1);
    assert.deepEqual(fixture.pending, []);
  } finally {
    db.close();
  }
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

test("pre-atomic finalization failure retries the original batch and outbox identity once", async () => {
  let analyzerCalls = 0;
  const fixture = runnerFixture({
    messages: [message("om-a", "A")], persistAnalysis: true, finalizeErrorOnce: true,
    analyze: async () => { analyzerCalls += 1; return { items: [{ messageIds: ["om-a"], disposition: "candidate_pool" }] }; },
    applyPolicy: async () => ({ replyRequired: true, reply: "同一回复", actions: [], schedule: { version: 4, blocks: [] } }),
  });
  await assert.rejects(fixture.runner.run({ now: "2026-07-13T09:00:00+08:00", forcedNode: "09:00" }), /before atomic finalize/);
  assert.deepEqual(fixture.pending.map((item) => item.messageId), ["om-a"]);
  await fixture.runner.run({ now: "2026-07-13T09:00:00+08:00", forcedNode: "09:00" });
  assert.equal(analyzerCalls, 1);
  const keys = fixture.outbox.map((item) => item.idempotencyKey);
  assert.equal(keys.length, 2);
  assert.equal(keys[0], keys[1]);
  assert.equal(fixture.calls.includes("complete"), false);
  assert.deepEqual(fixture.pending, []);
});

function realFeedbackRetryFixture({
  crashAfterFeedback = false,
  crashAfterScheduleCommit = false,
  crashAfterSummary = false,
  failPushOnce = false,
} = {}) {
  const now = "2026-07-13T04:00:00.000Z";
  const db = openDatabase(":memory:");
  let sequence = 0;
  const id = () => `retry-${++sequence}`;
  const tasks = createTaskRepository(db, { now: () => now, id });
  const ops = createOperationsRepository(db, { now: () => now, id });
  const storedRuntime = createAutomationRepository(db, { now: () => now, claimToken: id });
  let failFinalize = crashAfterSummary;
  const runtime = {
    ...storedRuntime,
    finalizeInbound(input) {
      if (failFinalize) {
        failFinalize = false;
        throw new Error("crash after main summary delivery");
      }
      return storedRuntime.finalizeInbound(input);
    },
  };
  let feedbackUpdates = 0;
  const update = tasks.update.bind(tasks);
  tasks.update = (taskId, patch) => {
    if (Object.hasOwn(patch, "checkpoints")) feedbackUpdates += 1;
    return update(taskId, patch);
  };
  const managerAnalyzer = {
    analyzeTask: async () => assert.fail("ordinary analysis is outside this retry"),
    minimumAction: async () => ({ action: "先录制第一条口播", minutes: 15 }),
  };
  let baseManager;
  const reminderEngine = createReminderEngine({
    tasks,
    ops,
    analyzer: managerAnalyzer,
    replan: (input) => baseManager.replanDay({ reason: input.reason, now: input.now }),
    clock: { now: () => new Date(now) },
  });
  baseManager = createManagerService({
    db,
    transaction: (fn) => withTransaction(db, fn),
    tasks,
    ops,
    analyzer: managerAnalyzer,
    reminderEngine,
    clock: { now: () => new Date(now) },
    settings: {
      timezone: "Asia/Shanghai",
      windows: [["10:00", "12:00"], ["14:00", "18:00"]],
      maxCriticalTasks: 3,
      noResponseMinutes: 15,
      projectBoosts: [],
    },
  });
  let failFeedback = crashAfterFeedback;
  const manager = {
    ...baseManager,
    applyTaskFeedback(input) {
      const result = baseManager.applyTaskFeedback(input);
      if (failFeedback) {
        failFeedback = false;
        throw new Error("crash after feedback commit before replan");
      }
      return result;
    },
  };
  tasks.create({
    id: "video-task",
    title: "个人IP｜录制3条口播",
    rawInput: "录制3条口播",
    status: "scheduled",
    estimateMinutes: 60,
    nextAction: "录制3条口播",
    doneDefinition: "3条可剪辑原片已提交",
    checkpoints: [
      {
        title: "完成3条口播提纲",
        minutes: 30,
        startsAt: "2026-07-13T02:00:00.000Z",
        endsAt: "2026-07-13T02:30:00.000Z",
        completed: true,
      },
      {
        title: "录制3条可剪辑口播",
        minutes: 60,
        startsAt: "2026-07-13T06:00:00.000Z",
        endsAt: "2026-07-13T07:00:00.000Z",
        completed: false,
      },
    ],
  });
  ops.replaceSchedule({ date: "2026-07-13", blocks: [{
    taskId: "video-task",
    checkpointIndex: 1,
    startsAt: "2026-07-13T06:00:00.000Z",
    endsAt: "2026-07-13T07:00:00.000Z",
    status: "planned",
    reason: "original scope",
  }] });
  if (crashAfterScheduleCommit) {
    const replaceSchedule = ops.replaceSchedule.bind(ops);
    let failScheduleCommit = true;
    ops.replaceSchedule = (input) => {
      const result = replaceSchedule(input);
      if (failScheduleCommit && input.event) {
        failScheduleCommit = false;
        throw new Error("crash after schedule commit before reminders");
      }
      return result;
    };
  }
  const policy = createCheckpointPolicy({
    manager,
    tasks,
    links: storedRuntime,
    timezone: "Asia/Shanghai",
    getSchedule: (date) => ({ date, blocks: ops.currentSchedule(date) }),
  });
  const source = messageAt("om-delay", "来不及拍3条了，今天缩减为先拍1条", "2026-07-13T03:50:00.000Z");
  let analyzerCalls = 0;
  let pushes = 0;
  let deliveries = 0;
  let failPush = failPushOnce;
  const worker = createOutboxWorker({
    ops,
    clock: { now: () => new Date(now) },
    send: async () => { deliveries += 1; return { messageId: `reply-${deliveries}` }; },
  });
  const runner = createCheckpointRunner({
    config: { timezone: "Asia/Shanghai", managerUserId: "ou-owner" },
    runtime,
    resolveChatId: async () => "oc-p2p",
    pollMessages: async () => [source],
    taskSync: {
      pullProgress: async () => ({ completedTasks: [], completedCheckpoints: [] }),
      pushSchedule: async () => {
        pushes += 1;
        if (failPush) {
          failPush = false;
          throw new Error("crash after replan before private summary");
        }
        return { tasks: [] };
      },
    },
    analyzer: {
      analyzeCheckpointMessages: async () => {
        analyzerCalls += 1;
        return { items: [{
          messageIds: ["om-delay"],
          disposition: "task_feedback",
          taskId: "video-task",
          title: "缩减为录制1条口播",
          nextAction: "录制1条可剪辑口播",
          doneDefinition: "1条可剪辑原片已提交",
          estimateMinutes: 30,
          checkpoints: [{ title: "录制1条可剪辑口播", minutes: 30 }],
        }] };
      },
    },
    policy,
    ops,
    outboxWorker: worker,
    clock: { now: () => new Date(now) },
    buildAnalysisContext: ({ workDate }) => ({ schedule: { date: workDate, blocks: ops.currentSchedule(workDate) } }),
    getCompletedNodes: () => [],
    owner: () => "retry-runner",
  });

  return {
    now,
    db,
    tasks,
    ops,
    runner,
    stats: () => ({ analyzerCalls, feedbackUpdates, pushes, deliveries }),
  };
}

test("real failed-run retry applies grounded task feedback once without another schedule or DM", async () => {
  const fixture = realFeedbackRetryFixture({ crashAfterSummary: true });

  try {
    await assert.rejects(
      fixture.runner.run({ now: fixture.now, forcedNode: "12:00" }),
      /crash after main summary delivery/,
    );
    const afterFirst = fixture.tasks.findById("video-task");
    await fixture.runner.run({ now: fixture.now, forcedNode: "12:00" });

    assert.deepEqual(fixture.stats(), { analyzerCalls: 1, feedbackUpdates: 1, pushes: 2, deliveries: 1 });
    assert.deepEqual(fixture.tasks.findById("video-task"), afterFirst);
    assert.deepEqual([...new Set(fixture.ops.listScheduleHistory("2026-07-13").map((block) => block.version))], [1, 2]);
    assert.equal(fixture.ops.listEvents({ taskId: "video-task", kind: "task_feedback_applied" }).length, 1);
    assert.equal(fixture.ops.listOutbox().filter((row) => row.kind === "private_checkpoint_summary").length, 1);
  } finally {
    fixture.db.close();
  }
});

test("real retry resumes the one required replan after feedback committed before a crash", async () => {
  const fixture = realFeedbackRetryFixture({ crashAfterFeedback: true });

  try {
    await assert.rejects(
      fixture.runner.run({ now: fixture.now, forcedNode: "12:00" }),
      /crash after feedback commit before replan/,
    );
    assert.deepEqual(fixture.stats(), { analyzerCalls: 1, feedbackUpdates: 1, pushes: 0, deliveries: 0 });
    assert.deepEqual([...new Set(fixture.ops.listScheduleHistory("2026-07-13").map((block) => block.version))], [1]);
    assert.equal(fixture.ops.listEvents({ taskId: "video-task", kind: "task_feedback_applied" }).length, 1);

    await fixture.runner.run({ now: fixture.now, forcedNode: "12:00" });

    assert.deepEqual(fixture.stats(), { analyzerCalls: 1, feedbackUpdates: 1, pushes: 1, deliveries: 1 });
    assert.deepEqual([...new Set(fixture.ops.listScheduleHistory("2026-07-13").map((block) => block.version))], [1, 2]);
    assert.equal(fixture.ops.listEvents({ taskId: "video-task", kind: "task_feedback_applied" }).length, 1);
    assert.equal(fixture.ops.listOutbox().filter((row) => row.kind === "private_checkpoint_summary").length, 1);
  } finally {
    fixture.db.close();
  }
});

test("real retry reuses the feedback schedule and delivers one summary after pre-summary failure", async () => {
  const fixture = realFeedbackRetryFixture({ failPushOnce: true });

  try {
    await assert.rejects(
      fixture.runner.run({ now: fixture.now, forcedNode: "12:00" }),
      /crash after replan before private summary/,
    );
    assert.deepEqual([...new Set(fixture.ops.listScheduleHistory("2026-07-13").map((block) => block.version))], [1, 2]);

    await fixture.runner.run({ now: fixture.now, forcedNode: "12:00" });

    assert.deepEqual(fixture.stats(), { analyzerCalls: 1, feedbackUpdates: 1, pushes: 2, deliveries: 2 });
    assert.deepEqual([...new Set(fixture.ops.listScheduleHistory("2026-07-13").map((block) => block.version))], [1, 2]);
    const mainSummaries = fixture.ops.listOutbox().filter((row) => row.kind === "private_checkpoint_summary"
      && !row.idempotencyKey.startsWith("private-sync-failure:"));
    assert.equal(mainSummaries.length, 1);
    assert.equal(mainSummaries[0].status, "sent");
    assert.equal(fixture.ops.listEvents({ taskId: "video-task", kind: "task_feedback_applied" }).length, 1);
  } finally {
    fixture.db.close();
  }
});

test("real retry restores reminders after the feedback schedule commits before a crash", async () => {
  const fixture = realFeedbackRetryFixture({ crashAfterScheduleCommit: true });

  try {
    await assert.rejects(
      fixture.runner.run({ now: fixture.now, forcedNode: "12:00" }),
      /crash after schedule commit before reminders/,
    );
    assert.deepEqual([...new Set(fixture.ops.listScheduleHistory("2026-07-13").map((block) => block.version))], [1, 2]);
    assert.equal(fixture.ops.listReminders({ taskId: "video-task" }).length, 0);

    await fixture.runner.run({ now: fixture.now, forcedNode: "12:00" });

    const reminders = fixture.ops.listReminders({ taskId: "video-task" });
    assert.equal(reminders.length, 3);
    assert.equal(reminders.every((reminder) => reminder.status === "pending"), true);
    assert.equal(reminders.every((reminder) => reminder.idempotencyKey.includes(":2:")), true);
    assert.deepEqual([...new Set(fixture.ops.listScheduleHistory("2026-07-13").map((block) => block.version))], [1, 2]);
    assert.deepEqual(fixture.stats(), { analyzerCalls: 1, feedbackUpdates: 1, pushes: 1, deliveries: 1 });
  } finally {
    fixture.db.close();
  }
});

test("real 08:00 feedback retry reuses the one daily dispatch schedule", async () => {
  const fixture = realFeedbackRetryFixture({ crashAfterSummary: true });

  try {
    await assert.rejects(
      fixture.runner.run({ now: fixture.now, forcedNode: "08:00" }),
      /crash after main summary delivery/,
    );
    await fixture.runner.run({ now: fixture.now, forcedNode: "08:00" });

    assert.deepEqual([...new Set(fixture.ops.listScheduleHistory("2026-07-13").map((block) => block.version))], [1, 2]);
    assert.deepEqual(fixture.stats(), { analyzerCalls: 1, feedbackUpdates: 1, pushes: 2, deliveries: 1 });
    const dispatchEvents = fixture.ops.listEvents({ kind: "daily_plan_created" })
      .filter((event) => event.idempotencyKey.startsWith("task-feedback-replan:"));
    assert.equal(dispatchEvents.length, 1);
  } finally {
    fixture.db.close();
  }
});

for (const node of ["18:00", "21:00"]) {
  test(`real ${node} feedback retry reuses the one evening schedule`, async () => {
    const fixture = realFeedbackRetryFixture({ crashAfterSummary: true });

    try {
      await assert.rejects(
        fixture.runner.run({ now: fixture.now, forcedNode: node }),
        /crash after main summary delivery/,
      );
      await fixture.runner.run({ now: fixture.now, forcedNode: node });

      assert.deepEqual([...new Set(fixture.ops.listScheduleHistory("2026-07-13").map((block) => block.version))], [1, 2]);
      assert.deepEqual(fixture.stats(), { analyzerCalls: 1, feedbackUpdates: 1, pushes: 2, deliveries: 1 });
    } finally {
      fixture.db.close();
    }
  });
}

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

test("CLI replay token requires an explicit checkpoint node", () => {
  const result = spawnSync(process.execPath, ["scripts/run-checkpoint.mjs", "--replay-token=brief-v2"], {
    cwd: path.resolve(import.meta.dirname, ".."), encoding: "utf8",
    env: { ...process.env, FEISHU_APP_ID: "", FEISHU_APP_SECRET: "" },
  });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /replay token requires forced checkpoint node/);
  assert.doesNotMatch(result.stdout, /brief-v2/);
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

function runnerFixture({ messages = [], pendingMessages = [], pollMessages, completedNodes = [], syncError = null, healthyProgress = false, lockHeld = false, managerUserId = "ou-owner", reconcileRemoteProgress, reconcileProjectWrites, buildAnalysisContext, analyze, applyPolicy, pushSchedule, persistAnalysis = false, finalizeErrorOnce = false, executionNow, onClaimLock, initialRunStatuses = [], idempotentRuns = false, initialCursor = null } = {}) {
  const calls = [];
  const claims = [];
  const polls = [];
  const outbox = [];
  const pending = [...pendingMessages];
  const finalizedThrough = [];
  let cursor = initialCursor;
  let shouldFailFinalize = finalizeErrorOnce;
  const savedAnalyses = new Map();
  const runStatuses = new Map(initialRunStatuses);
  const successfulClaims = [];
  const runtime = {
    claimLock: (input) => { calls.push("lock"); onClaimLock?.(input); return !lockHeld; },
    releaseLock: () => { calls.push("unlock"); },
    claimRun: (input) => {
      calls.push("claim");
      claims.push(input);
      if (idempotentRuns && runStatuses.get(input.runKey) === "completed") return { claimed: false };
      runStatuses.set(input.runKey, "running");
      successfulClaims.push(input.runKey);
      return { claimed: true, claimToken: "claim-1" };
    },
    failRun: (runKey) => { calls.push("fail"); runStatuses.set(runKey, "failed"); },
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
      if (shouldFailFinalize) { shouldFailFinalize = false; throw new Error("before atomic finalize"); }
      finalizedThrough.push(polledThrough);
      assert.equal(claimToken, "claim-1");
      pending.splice(0, pending.length, ...pending.filter((item) => !messageIds.includes(item.messageId)));
      cursor = polledThrough;
      const running = [...runStatuses.entries()].find(([, status]) => status === "running");
      if (running) runStatuses.set(running[0], "completed");
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
    get runner() { return runner; }, runtime, calls, claims, successfulClaims, polls, finalizedThrough, outbox, pending, runStatuses, get cursor() { return cursor; },
    setDelivery(overrides) { Object.assign(deps, overrides); runner = createCheckpointRunner(deps); },
  };
}

function message(messageId, text) {
  return { messageId, chatId: "oc-p2p", senderId: "ou-owner", messageType: "text", content: { text }, createdAt: "2026-07-13T00:30:00.000Z" };
}

function messageAt(messageId, text, createdAt) {
  return { ...message(messageId, text), createdAt };
}

function digestMessages(messages) {
  return createHash("sha256").update(JSON.stringify(messages.map((item) => ({
    id: item.messageId, content: item.content,
  })))).digest("hex");
}
