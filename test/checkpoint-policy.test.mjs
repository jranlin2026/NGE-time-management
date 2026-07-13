import assert from "node:assert/strict";
import test from "node:test";
import { createCheckpointPolicy } from "../src/lib/checkpoint-policy.mjs";

const emptyProgress = { completedTasks: [], completedCheckpoints: [] };

function task(overrides = {}) {
  return {
    id: "task-1", title: "完成口播", status: "scheduled", project: "个人IP",
    nextAction: "写脚本", doneDefinition: "发布链接", estimateMinutes: 60,
    checkpoints: [{ title: "写脚本", minutes: 30, completed: false }],
    ...overrides,
  };
}

function policyFixture({ scheduledTask = null, doingTask = null, remainingTasks = [], schedule = null, previousSchedule = null, handleActionResult = null } = {}) {
  const created = [];
  const handled = [];
  const replans = [];
  const tasks = [doingTask, scheduledTask, ...remainingTasks].filter(Boolean);
  const manager = {
    handleAction: async (input) => { handled.push(input); return handleActionResult || { action: input.action }; },
    replanDay: async (input) => {
      replans.push(input);
      const planned = (typeof schedule === "function" ? schedule(tasks) : schedule)
        || ({ date: "2026-07-13", version: 1, blocks: tasks.map((item) => ({ taskId: item.id })) });
      if (!Number.isInteger(input.maxCriticalTasks)) return planned;
      const keptTaskIds = [...new Set(planned.blocks.map((block) => block.taskId))]
        .slice(0, input.maxCriticalTasks);
      return { ...planned, blocks: planned.blocks.filter((block) => keptTaskIds.includes(block.taskId)) };
    },
    dispatchDay: async () => (typeof schedule === "function" ? schedule(tasks) : schedule) || ({ date: "2026-07-13", version: 1, blocks: tasks.map((item) => ({ taskId: item.id })) }),
  };
  return {
    created, handled, replans,
    policy: createCheckpointPolicy({
      manager,
      tasks: {
        listActive: () => tasks,
        findDoing: () => doingTask,
        findById: (id) => tasks.find((item) => item.id === id),
        create: (input) => {
          const existing = tasks.find((item) => item.id === input.id);
          if (existing) return existing;
          created.push(input);
          const saved = task({ id: `new-${created.length}`, ...input });
          tasks.push(saved);
          return saved;
        },
      },
      getSchedule: () => previousSchedule || { date: "2026-07-13", blocks: [] },
      timezone: "Asia/Shanghai",
      reviewDay: async () => ({ renderedText: "今日复盘：完成 1 项" }),
    }),
  };
}

test("08:00 sends the full executable brief", async () => {
  const scheduledTask = task({
    doneDefinition: "提交口播脚本初稿",
    checkpoints: [{ title: "写脚本", minutes: 20, completed: false }],
  });
  const schedule = {
    date: "2026-07-13",
    version: 1,
    blocks: [{
      taskId: scheduledTask.id,
      checkpointIndex: 0,
      startsAt: "2026-07-13T02:15:00.000Z",
      endsAt: "2026-07-13T02:35:00.000Z",
    }],
  };

  const result = await policyFixture({ scheduledTask, schedule }).policy.apply({
    node: "08:00", workDate: "2026-07-13", messages: [], analysis: { items: [] }, remoteProgress: emptyProgress,
  });

  assert.match(result.reply, /10:15–10:35/);
  assert.match(result.reply, /今天按这个节奏走/);
  assert.match(result.reply, /做到：提交口播脚本初稿/);
  assert.match(result.reply, /卡住了直接回我卡在哪/);
});

test("09:00 stays silent without messages or changes", async () => {
  const scheduledTask = task();
  const unchanged = { date: "2026-07-13", blocks: [{ taskId: scheduledTask.id, checkpointIndex: 0, startsAt: "2026-07-13T01:00:00.000Z", endsAt: "2026-07-13T02:00:00.000Z" }] };
  const result = await policyFixture({ scheduledTask, previousSchedule: unchanged }).policy.apply({ node: "09:00", workDate: "2026-07-13", messages: [], analysis: { items: [] }, remoteProgress: emptyProgress });
  assert.equal(result.replyRequired, false);
  assert.equal(result.changed, false);
});

test("09:00 calibration replans from the execution instant", async () => {
  const fixture = policyFixture();
  const now = "2026-07-13T01:07:00.000Z";

  await fixture.policy.apply({
    node: "09:00",
    workDate: "2026-07-13",
    now,
    messages: [{ messageId: "om-idea" }],
    analysis: { items: [{ disposition: "candidate_pool", title: "备选口播题目" }] },
    remoteProgress: emptyProgress,
  });

  assert.deepEqual(fixture.replans, [{
    date: "2026-07-13",
    now,
    reason: "checkpoint_09:00",
    deliveryMode: "task_dm",
  }]);
});

test("12:00 turns zero progress into one 15-minute action", async () => {
  const result = await policyFixture({ scheduledTask: task() }).policy
    .apply({ node: "12:00", workDate: "2026-07-13", messages: [], analysis: { items: [] }, remoteProgress: emptyProgress });
  assert.match(result.reply, /15分钟/);
  assert.match(result.reply, /写脚本/);
});

test("12:00 progress replan uses the execution instant", async () => {
  const fixture = policyFixture();
  const now = "2026-07-13T04:11:00.000Z";

  await fixture.policy.apply({
    node: "12:00",
    workDate: "2026-07-13",
    now,
    messages: [{ messageId: "om-noise" }],
    analysis: { items: [{ disposition: "candidate_pool", title: "稍后再验证的想法" }] },
    remoteProgress: emptyProgress,
  });

  assert.deepEqual(fixture.replans, [{
    date: "2026-07-13",
    now,
    reason: "checkpoint_12:00",
    deliveryMode: "task_dm",
  }]);
});

test("12:00 early completion adds one high-value action and retains the buffer", async () => {
  const completed = task({ id: "completed", title: "完成初稿" });
  const highValue = task({ id: "high", title: "录制高价值视频", checkpoints: [{ title: "录制第一条", minutes: 30, completed: false }] });
  const previousSchedule = { date: "2026-07-13", blocks: [{ taskId: "completed", checkpointIndex: 0, startsAt: "2026-07-13T02:00:00.000Z", endsAt: "2026-07-13T02:30:00.000Z" }] };
  const schedule = { date: "2026-07-13", blocks: [
    { taskId: "high", checkpointIndex: 0, startsAt: "2026-07-13T06:00:00.000Z", endsAt: "2026-07-13T06:30:00.000Z" },
  ] };
  const result = await policyFixture({ remainingTasks: [completed, highValue], previousSchedule, handleActionResult: { action: "complete_checkpoint", schedule } }).policy.apply({
    node: "12:00", workDate: "2026-07-13", messages: [], analysis: { items: [] },
    remoteProgress: { completedTasks: [], completedCheckpoints: [{ localTaskId: "completed", checkpointIndex: 0, completedAt: "2026-07-13T03:30:00.000Z" }] },
  });

  assert.match(result.reply, /录制第一条/);
  assert.equal(result.reply.match(/加上「/gu)?.length, 1);
  assert.match(result.reply, /现在先做：/);
  assert.match(result.reply, /15:00前告诉我结果/);
  assert.equal(result.schedule.blocks[0].startsAt, "2026-07-13T06:00:00.000Z");
});

test("12:00 delay reduces scope and reports the new end time", async () => {
  const delayed = task({ id: "delayed", title: "录制口播", checkpoints: [{ title: "只录一条", minutes: 30, completed: false }] });
  const previousSchedule = { date: "2026-07-13", blocks: [{ taskId: "delayed", checkpointIndex: 0, startsAt: "2026-07-13T06:00:00.000Z", endsAt: "2026-07-13T07:00:00.000Z" }] };
  const schedule = { date: "2026-07-13", blocks: [{ taskId: "delayed", checkpointIndex: 0, startsAt: "2026-07-13T06:00:00.000Z", endsAt: "2026-07-13T06:30:00.000Z" }] };
  const result = await policyFixture({ scheduledTask: delayed, previousSchedule, schedule }).policy.apply({
    node: "12:00", workDate: "2026-07-13", messages: [{ messageId: "om-delay" }], remoteProgress: emptyProgress,
    analysis: { items: [{ disposition: "task_feedback", taskId: "delayed", title: "延迟：缩减为只录一条" }] },
  });

  assert.match(result.reply, /只录一条/);
  assert.match(result.reply, /改到 14:00–14:30/);
  assert.match(result.reply, /现在先做：/);
  assert.match(result.reply, /15:00前告诉我结果/);
});

test("candidate ideas never interrupt a doing task", async () => {
  const result = await policyFixture({ doingTask: task({ status: "doing" }) }).policy
    .apply({ node: "15:00", workDate: "2026-07-13", messages: [{ messageId: "om-1" }], analysis: { items: [{ messageIds: ["om-1"], disposition: "candidate_pool", title: "新选题" }] }, remoteProgress: emptyProgress });
  assert.equal(result.actions.some((item) => item.type === "interrupt_current"), false);
  assert.match(result.reply, /新想法我先替你收着/);
});

test("an ungrounded interrupt is downgraded and cannot interrupt current work", async () => {
  const fixture = policyFixture({ doingTask: task({ id: "doing", status: "doing" }) });
  const result = await fixture.policy.apply({
    node: "15:00", workDate: "2026-07-13", messages: [{ messageId: "om-bad" }], remoteProgress: emptyProgress,
    analysis: { items: [{ disposition: "interrupt_now", title: "伪造紧急任务", checkpoints: [{ title: "立即处理", minutes: 15 }] }] },
  });
  assert.equal(fixture.created.length, 0);
  assert.equal(result.actions.some((item) => item.type === "interrupt_current"), false);
  assert.match(result.reply, /新想法我先替你收着/);
});

test("a grounded P0 interrupts only when a different task is doing", async () => {
  const fixture = policyFixture({ doingTask: task({ id: "doing", status: "doing" }) });
  const result = await fixture.policy.apply({
    node: "15:00", workDate: "2026-07-13", messages: [{ messageId: "om-p0" }], remoteProgress: emptyProgress,
    analysis: { items: [{ disposition: "interrupt_now", groundedP0: true, title: "修复不可用故障", checkpoints: [{ title: "导出故障日志", minutes: 15 }] }] },
  });
  assert.equal(result.actions.some((item) => item.type === "interrupt_current"), true);
});

test("do-not-schedule inputs are explained in the one merged reply", async () => {
  const result = await policyFixture().policy.apply({
    node: "09:00", workDate: "2026-07-13", messages: [{ messageId: "om-2" }], remoteProgress: emptyProgress,
    analysis: { items: [{ disposition: "do_not_schedule", title: "低价值整理", rationale: "可以委派给员工" }] },
  });
  assert.equal(result.replyRequired, true);
  assert.match(result.reply, /今天先不插队.*可以委派给员工/);
});

test("21:00 keeps one core task through midnight", async () => {
  const now = "2026-07-13T13:04:00.000Z";
  const fixture = policyFixture({ remainingTasks: [task({ id: "a" }), task({ id: "b" })] });
  const result = await fixture.policy
    .apply({ node: "21:00", workDate: "2026-07-13", now, messages: [], analysis: { items: [] }, remoteProgress: emptyProgress });
  assert.equal(result.schedule.blocks.length, 1);
  assert.equal(fixture.replans.at(-1).maxCriticalTasks, 1);
  assert.equal(fixture.replans.at(-1).now, now);
});

test("only actionable dispositions create tasks and retain timed checkpoint objects", async () => {
  const fixture = policyFixture();
  await fixture.policy.apply({
    node: "09:00", workDate: "2026-07-13", messages: [{ messageId: "om-1" }], remoteProgress: emptyProgress,
    analysis: { items: [
      { disposition: "schedule_today", title: "写新脚本", estimateMinutes: 45, checkpoints: [{ title: "列提纲", minutes: 15 }] },
      { disposition: "candidate_pool", title: "以后再拍", estimateMinutes: 30, checkpoints: [{ title: "记想法", minutes: 15 }] },
    ] },
  });
  assert.equal(fixture.created.length, 1);
  assert.deepEqual(fixture.created[0].checkpoints, [{ title: "列提纲", minutes: 15, completed: false }]);
});

test("retrying a failed batch reuses the same stable local task id", async () => {
  const fixture = policyFixture();
  const input = {
    node: "09:00", workDate: "2026-07-13", messages: [{ messageId: "om-b" }, { messageId: "om-a" }], remoteProgress: emptyProgress,
    analysis: { items: [{ messageIds: ["om-b", "om-a"], disposition: "schedule_today", title: "写稳定脚本", estimateMinutes: 30, checkpoints: [{ title: "写出脚本初稿", minutes: 30 }] }] },
  };
  await fixture.policy.apply(input);
  await fixture.policy.apply(input);
  assert.equal(fixture.created.length, 1);
  assert.match(fixture.created[0].id, /^checkpoint-[a-f0-9]{32}$/);
});

test("evidence uses exact referenced source text and ignores model-authored claims", async () => {
  let submitted;
  const policy = createCheckpointPolicy({
    manager: {
      submitEvidence: async (input) => { submitted = input; return { status: "needs_user_confirmation" }; },
      listPendingAcceptance: () => [{ id: "pending-1" }],
      replanDay: async () => ({ blocks: [] }),
    },
    tasks: { listActive: () => [], findDoing: () => null, create: () => assert.fail("must not create task") },
  });
  await policy.apply({
    node: "09:00", workDate: "2026-07-13", remoteProgress: emptyProgress,
    messages: [{ messageId: "om-proof", content: { text: "  用户只说完成初稿   https://example.com/draft  " } }],
    analysis: { items: [{
      messageIds: ["om-proof"], disposition: "evidence_submission", taskId: null, title: "证据",
      evidence: { messageIds: ["om-proof"], text: "已正式发布并验收", links: ["https://example.com/invented"] },
    }] },
  });
  assert.deepEqual(submitted.evidence, [
    { type: "text", value: "用户只说完成初稿 https://example.com/draft" },
    { type: "url", value: "https://example.com/draft" },
  ]);
  assert.doesNotMatch(JSON.stringify(submitted.evidence), /正式发布|invented/);
});

test("12:00 schedules a newly created today task before progress handling", async () => {
  const fixture = policyFixture();
  const result = await fixture.policy.apply({
    node: "12:00", workDate: "2026-07-13", messages: [{ messageId: "om-12" }], remoteProgress: emptyProgress,
    analysis: { items: [{ disposition: "schedule_today", title: "写午间脚本", estimateMinutes: 30, checkpoints: [{ title: "写出脚本初稿", minutes: 30 }] }] },
  });
  assert.equal(fixture.replans.length, 1);
  assert.equal(fixture.replans[0].deliveryMode, "task_dm");
  assert.equal(result.schedule.blocks.some((block) => block.taskId === fixture.created[0].id), true);
});

test("15:00 replans a new task even while preserving a doing task", async () => {
  const doingTask = task({ id: "doing", status: "doing" });
  const doingBlock = { taskId: "doing", checkpointIndex: 0, startsAt: "2026-07-13T06:30:00.000Z", endsAt: "2026-07-13T07:30:00.000Z" };
  const fixture = policyFixture({
    doingTask,
    previousSchedule: { date: "2026-07-13", blocks: [doingBlock] },
    schedule: (tasks) => ({ date: "2026-07-13", blocks: [doingBlock, { taskId: tasks.at(-1).id, checkpointIndex: 0, startsAt: "2026-07-13T07:30:00.000Z", endsAt: "2026-07-13T08:00:00.000Z" }] }),
  });
  const result = await fixture.policy.apply({
    node: "15:00", workDate: "2026-07-13", messages: [{ messageId: "om-15" }], remoteProgress: emptyProgress,
    analysis: { items: [{ disposition: "schedule_today", title: "下午交付", estimateMinutes: 30, checkpoints: [{ title: "导出交付文件", minutes: 30 }] }] },
  });
  assert.equal(fixture.replans.length, 1);
  assert.deepEqual(result.schedule.blocks.map((block) => block.taskId), ["doing", fixture.created[0].id]);
  assert.deepEqual(result.schedule.blocks[0], doingBlock);
  assert.match(result.reply, /现在先做：/);
  assert.match(result.reply, /18:00前告诉我结果/);
  assert.doesNotMatch(result.reply, /改到.*完成口播/);
});

test("18:00 lists kept and removed evening work", async () => {
  const now = "2026-07-13T10:03:00.000Z";
  const kept = task({ id: "kept", title: "交付今日脚本" });
  const removed = task({ id: "removed", title: "整理低价值素材" });
  const previousSchedule = { date: "2026-07-13", blocks: [
    { taskId: "kept", checkpointIndex: 0, startsAt: "2026-07-13T10:30:00.000Z", endsAt: "2026-07-13T11:00:00.000Z" },
    { taskId: "removed", checkpointIndex: 0, startsAt: "2026-07-13T11:00:00.000Z", endsAt: "2026-07-13T11:30:00.000Z" },
  ] };
  const schedule = { date: "2026-07-13", blocks: previousSchedule.blocks };
  const fixture = policyFixture({ remainingTasks: [kept, removed], previousSchedule, schedule });
  const result = await fixture.policy.apply({
    node: "18:00", workDate: "2026-07-13", now, messages: [], analysis: { items: [] }, remoteProgress: emptyProgress,
  });
  assert.equal(fixture.replans.at(-1).maxCriticalTasks, 1);
  assert.equal(fixture.replans.at(-1).now, now);
  assert.match(result.reply, /交付今日脚本/);
  assert.match(result.reply, /今天先不硬塞/);
  assert.match(result.reply, /现在先做：/);
  assert.match(result.reply, /21:00前告诉我结果/);
});

test("21:00 keeps one final outcome with an absolute deadline", async () => {
  const finalTask = task({ id: "final", title: "发布最终口播" });
  const block = { taskId: "final", checkpointIndex: 0, startsAt: "2026-07-13T13:00:00.000Z", endsAt: "2026-07-13T14:00:00.000Z" };
  const result = await policyFixture({ scheduledTask: finalTask, previousSchedule: { date: "2026-07-13", blocks: [] }, schedule: { date: "2026-07-13", blocks: [block] } }).policy.apply({
    node: "21:00", workDate: "2026-07-13", messages: [], analysis: { items: [] }, remoteProgress: emptyProgress,
  });
  assert.equal(result.schedule.blocks.length, 1);
  assert.match(result.reply, /现在先做：.*写脚本/);
  assert.match(result.reply, /24:00前告诉我结果/);
  assert.doesNotMatch(result.reply, /今日胜利条件|反馈规则/);
});

test("21:00 selects a final block ending at next-day midnight", async () => {
  const finalTask = task({ id: "midnight", title: "发布最终视频", checkpoints: [{ title: "完成发布", minutes: 30, completed: false }] });
  const block = { taskId: "midnight", checkpointIndex: 0, startsAt: "2026-07-13T15:30:00.000Z", endsAt: "2026-07-13T16:00:00.000Z" };
  const result = await policyFixture({ scheduledTask: finalTask, previousSchedule: { date: "2026-07-13", blocks: [] }, schedule: { date: "2026-07-13", blocks: [block] } }).policy.apply({
    node: "21:00", workDate: "2026-07-13", messages: [], analysis: { items: [] }, remoteProgress: emptyProgress,
  });

  assert.match(result.reply, /现在先做：完成发布/);
  assert.match(result.reply, /23:30–24:00/);
  assert.doesNotMatch(result.reply, /23:30–00:00/);
});

test("21:00 sends final sprint for an unchanged unfinished critical outcome", async () => {
  const doingTask = task({ id: "unchanged-final", title: "完成关键交付", status: "doing", checkpoints: [{ title: "导出最终版", minutes: 60, completed: false }] });
  const block = { taskId: "unchanged-final", checkpointIndex: 0, startsAt: "2026-07-13T12:00:00.000Z", endsAt: "2026-07-13T16:00:00.000Z" };
  const unchanged = { date: "2026-07-13", blocks: [block] };
  const result = await policyFixture({ doingTask, previousSchedule: unchanged, schedule: unchanged }).policy.apply({
    node: "21:00", workDate: "2026-07-13", messages: [], analysis: { items: [] }, remoteProgress: emptyProgress,
  });

  assert.equal(result.replyRequired, true);
  assert.match(result.reply, /还差最后一段/);
  assert.match(result.reply, /现在先做：导出最终版/);
  assert.match(result.reply, /24:00前告诉我结果/);
  assert.doesNotMatch(result.reply, /今日胜利条件|反馈规则/);
});

test("remote parent completion is routed through manager acceptance handling first", async () => {
  const now = "2026-07-13T07:05:00.000Z";
  const fixture = policyFixture({ scheduledTask: task({ id: "deliverable", requiresEvidence: true }), handleActionResult: { action: "evidence_required" } });
  const result = await fixture.policy.apply({ node: "12:00", workDate: "2026-07-13", now, messages: [], analysis: { items: [] }, remoteProgress: {
    completedTasks: [{ localTaskId: "deliverable", completedAt: "2026-07-13T03:00:00.000Z" }],
    completedCheckpoints: [],
  } });
  assert.deepEqual(fixture.handled[0], {
    action: "complete", taskId: "deliverable", date: "2026-07-13", now, idempotencyKey: "feishu-parent:deliverable:2026-07-13T03:00:00.000Z", deliveryMode: "task_dm", suppressOutbox: true,
  });
  assert.equal(result.replyRequired, true);
  assert.match(result.reply, /已经完成.*验收凭证/);
});

test("24:00 checkpoint completion replans the prior work date", async () => {
  const completedAt = "2026-07-13T16:00:00.000Z";
  const now = "2026-07-14T00:05:00.000Z";
  const fixture = policyFixture({
    scheduledTask: task({ id: "prior-day-task" }),
    handleActionResult: { action: "complete_checkpoint", schedule: { date: "2026-07-13", blocks: [] } },
  });

  await fixture.policy.apply({
    node: "24:00",
    workDate: "2026-07-13",
    now,
    messages: [],
    analysis: { items: [] },
    remoteProgress: {
      completedTasks: [],
      completedCheckpoints: [{
        localTaskId: "prior-day-task",
        checkpointIndex: 0,
        completedAt,
      }],
    },
  });

  assert.deepEqual(fixture.handled[0], {
    action: "complete_checkpoint",
    taskId: "prior-day-task",
    checkpointIndex: 0,
    date: "2026-07-13",
    now,
    idempotencyKey: `feishu-checkpoint:prior-day-task:0:${completedAt}`,
    deliveryMode: "task_dm",
    suppressOutbox: true,
  });
});

test("24:00 parent completion replans the prior work date", async () => {
  const completedAt = "2026-07-13T16:00:00.000Z";
  const fixture = policyFixture({
    scheduledTask: task({ id: "prior-day-parent" }),
    handleActionResult: { action: "complete", schedule: { date: "2026-07-13", blocks: [] } },
  });

  await fixture.policy.apply({
    node: "24:00",
    workDate: "2026-07-13",
    messages: [],
    analysis: { items: [] },
    remoteProgress: {
      completedTasks: [{ localTaskId: "prior-day-parent", completedAt }],
      completedCheckpoints: [],
    },
  });

  assert.deepEqual(fixture.handled[0], {
    action: "complete",
    taskId: "prior-day-parent",
    date: "2026-07-13",
    idempotencyKey: `feishu-parent:prior-day-parent:${completedAt}`,
    deliveryMode: "task_dm",
    suppressOutbox: true,
  });
});

test("all seven node handlers return a single decision envelope", async () => {
  for (const node of ["08:00", "09:00", "12:00", "15:00", "18:00", "21:00", "24:00"]) {
    const result = await policyFixture().policy.apply({ node, workDate: "2026-07-13", messages: [], analysis: { items: [] }, remoteProgress: emptyProgress });
    assert.equal(typeof result.replyRequired, "boolean", node);
    assert.equal(Array.isArray(result.actions), true, node);
  }
});
