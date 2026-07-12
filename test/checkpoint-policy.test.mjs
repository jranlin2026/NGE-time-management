import assert from "node:assert/strict";
import test from "node:test";
import { createCheckpointPolicy } from "../src/lib/checkpoint-policy.mjs";

const emptyProgress = { completedParents: [], completedCheckpoints: [] };

function task(overrides = {}) {
  return {
    id: "task-1", title: "完成口播", status: "scheduled", project: "个人IP",
    nextAction: "写脚本", doneDefinition: "发布链接", estimateMinutes: 60,
    checkpoints: [{ title: "写脚本", minutes: 30, completed: false }],
    ...overrides,
  };
}

function policyFixture({ scheduledTask = null, doingTask = null, remainingTasks = [], schedule = null } = {}) {
  const created = [];
  const handled = [];
  const tasks = [doingTask, scheduledTask, ...remainingTasks].filter(Boolean);
  const manager = {
    handleAction: async (input) => { handled.push(input); return { action: input.action }; },
    replanDay: async () => schedule || ({ date: "2026-07-13", version: 1, blocks: tasks.map((item) => ({ taskId: item.id })) }),
    dispatchDay: async () => ({ date: "2026-07-13", version: 1, blocks: tasks.map((item) => ({ taskId: item.id })) }),
  };
  return {
    created, handled,
    policy: createCheckpointPolicy({
      manager,
      tasks: {
        listActive: () => tasks,
        findDoing: () => doingTask,
        create: (input) => { created.push(input); return task({ id: `new-${created.length}`, ...input }); },
      },
      reviewDay: async () => ({ renderedText: "今日复盘：完成 1 项" }),
    }),
  };
}

test("09:00 stays silent without messages or changes", async () => {
  const result = await policyFixture().policy.apply({ node: "09:00", workDate: "2026-07-13", messages: [], analysis: { items: [] }, remoteProgress: emptyProgress });
  assert.equal(result.replyRequired, false);
  assert.equal(result.changed, false);
});

test("12:00 turns zero progress into one 15-minute action", async () => {
  const result = await policyFixture({ scheduledTask: task() }).policy
    .apply({ node: "12:00", workDate: "2026-07-13", messages: [], analysis: { items: [] }, remoteProgress: emptyProgress });
  assert.match(result.reply, /15分钟/);
  assert.match(result.reply, /写脚本/);
});

test("candidate ideas never interrupt a doing task", async () => {
  const result = await policyFixture({ doingTask: task({ status: "doing" }) }).policy
    .apply({ node: "15:00", workDate: "2026-07-13", messages: [{ messageId: "om-1" }], analysis: { items: [{ messageIds: ["om-1"], disposition: "candidate_pool", title: "新选题" }] }, remoteProgress: emptyProgress });
  assert.equal(result.actions.some((item) => item.type === "interrupt_current"), false);
  assert.match(result.reply, /候选池/);
});

test("do-not-schedule inputs are explained in the one merged reply", async () => {
  const result = await policyFixture().policy.apply({
    node: "09:00", workDate: "2026-07-13", messages: [{ messageId: "om-2" }], remoteProgress: emptyProgress,
    analysis: { items: [{ disposition: "do_not_schedule", title: "低价值整理", rationale: "可以委派给员工" }] },
  });
  assert.equal(result.replyRequired, true);
  assert.match(result.reply, /暂不安排.*可以委派给员工/);
});

test("21:00 keeps one core task through midnight", async () => {
  const result = await policyFixture({ remainingTasks: [task({ id: "a" }), task({ id: "b" })] }).policy
    .apply({ node: "21:00", workDate: "2026-07-13", messages: [], analysis: { items: [] }, remoteProgress: emptyProgress });
  assert.equal(result.schedule.blocks.length, 1);
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

test("remote parent completion is routed through manager acceptance handling first", async () => {
  const fixture = policyFixture({ scheduledTask: task({ id: "deliverable", requiresEvidence: true }) });
  await fixture.policy.apply({ node: "12:00", workDate: "2026-07-13", messages: [], analysis: { items: [] }, remoteProgress: {
    completedParents: [{ localTaskId: "deliverable", taskGuid: "ft-1", completedAt: "2026-07-13T03:00:00.000Z" }],
    completedCheckpoints: [],
  } });
  assert.deepEqual(fixture.handled[0], {
    action: "complete", taskId: "deliverable", idempotencyKey: "feishu-parent:ft-1:2026-07-13T03:00:00.000Z", deliveryMode: "task_dm",
  });
});

test("all seven node handlers return a single decision envelope", async () => {
  for (const node of ["08:00", "09:00", "12:00", "15:00", "18:00", "21:00", "24:00"]) {
    const result = await policyFixture().policy.apply({ node, workDate: "2026-07-13", messages: [], analysis: { items: [] }, remoteProgress: emptyProgress });
    assert.equal(typeof result.replyRequired, "boolean", node);
    assert.equal(Array.isArray(result.actions), true, node);
  }
});
