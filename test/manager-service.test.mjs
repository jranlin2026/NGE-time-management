import assert from "node:assert/strict";
import test from "node:test";
import { openDatabase, withTransaction } from "../src/db/database.mjs";
import { createTaskRepository } from "../src/db/task-repository.mjs";
import { createOperationsRepository } from "../src/db/operations-repository.mjs";
import { createAutomationRepository } from "../src/db/automation-repository.mjs";
import { createManagerService } from "../src/lib/manager-service.mjs";
import { createCheckpointPolicy } from "../src/lib/checkpoint-policy.mjs";

const NOW = "2026-07-10T00:30:00.000Z";

function setup(overrides = {}) {
  let sequence = 0;
  const id = () => `id-${++sequence}`;
  const db = openDatabase(":memory:");
  const tasks = createTaskRepository(db, { now: () => NOW, id });
  const ops = createOperationsRepository(db, { now: () => NOW, id });
  const scheduled = [];
  const manager = createManagerService({
    db,
    transaction: (fn) => withTransaction(db, fn),
    tasks,
    ops,
    analyzer: {
      analyzeTask: async () => ({
        title: "拍摄 3 条 Codex 口播",
        project: "个人IP",
        quadrant: "重要且紧急",
        importance: "A",
        urgency: "high",
        dueAt: "2026-07-10T10:00:00.000Z",
        estimateMinutes: 120,
        nextAction: "打开第一条提纲开始录制",
        doneDefinition: "3 条素材交给剪辑",
        analysisStatus: "complete",
      }),
      minimumAction: async () => ({ action: "先完整说一遍", minutes: 15 }),
    },
    reminderEngine: { scheduleTask: (...args) => scheduled.push(args) },
    clock: { now: () => new Date(NOW) },
    settings: {
      timezone: "Asia/Shanghai",
      windows: [["10:00", "12:00"], ["14:00", "18:00"], ["20:00", "22:00"]],
      maxCriticalTasks: 3,
      noResponseMinutes: 15,
      projectBoosts: [{ project: "个人IP", points: 100, startsOn: "2026-07-10", endsOn: "2026-07-15" }],
    },
    ...overrides,
  });
  return { db, tasks, ops, manager, scheduled };
}

function taskFeedback(overrides = {}) {
  return {
    messageIds: ["om-feedback"],
    disposition: "task_feedback",
    taskId: "video-task",
    title: "缩减为录制1条口播",
    nextAction: "录制1条可剪辑口播",
    doneDefinition: "1条可剪辑原片已提交",
    estimateMinutes: 30,
    checkpoints: [{ title: "录制1条可剪辑口播", minutes: 30 }],
    ...overrides,
  };
}

test("ingests one natural-language task, analyzes it, and ignores duplicate message", async () => {
  const { db, tasks, ops, manager } = setup();
  const first = await manager.ingest({
    messageId: "om-100",
    text: "今天拍 3 条 Codex 口播",
    senderId: "user-1",
  });
  const duplicate = await manager.ingest({
    messageId: "om-100",
    text: "今天拍 3 条 Codex 口播",
    senderId: "user-1",
  });

  assert.equal(first.id, duplicate.id);
  assert.equal(tasks.listActive().length, 1);
  assert.equal(tasks.findById(first.id).status, "scheduled");
  assert.deepEqual(
    ops.listEvents({ taskId: first.id }).map((event) => event.kind).slice(0, 2),
    ["task_created", "task_analyzed"],
  );
  assert.equal(ops.listOutbox().filter((row) => row.kind === "task_ack").length, 1);
  db.close();
});

test("completes a task and replans future blocks", async () => {
  const { db, tasks, ops, manager } = setup();
  const task = tasks.create({ id: "task-1", rawInput: "拍视频", title: "拍视频", status: "doing" });
  const result = await manager.handleAction({ action: "complete", taskId: task.id, idempotencyKey: "card:evt-1" });

  assert.equal(result.task.status, "done");
  assert.equal(ops.listEvents({ taskId: task.id }).some((event) => event.kind === "task_completed"), true);
  assert.equal(ops.listOutbox().some((row) => row.kind === "status_message"), true);
  assert.equal(ops.findEventByIdempotencyKey("card:evt-1").kind, "task_completed");
  db.close();
});

test("parent completion replans the supplied prior work date without replacing today", async () => {
  const { db, tasks, ops, manager } = setup();
  tasks.create({ id: "prior-parent", rawInput: "完成昨日交付", status: "doing" });
  tasks.create({ id: "today-task", rawInput: "今天任务", status: "ready" });
  ops.replaceSchedule({
    date: "2026-07-10",
    blocks: [{
      taskId: "today-task",
      startsAt: "2026-07-10T02:00:00.000Z",
      endsAt: "2026-07-10T02:30:00.000Z",
      status: "planned",
      reason: "test schedule",
    }],
  });
  const todayBefore = ops.currentSchedule("2026-07-10");

  const result = await manager.handleAction({
    action: "complete",
    taskId: "prior-parent",
    date: "2026-07-09",
    idempotencyKey: "prior-parent-complete",
    deliveryMode: "task_dm",
    suppressOutbox: true,
  });

  assert.equal(result.schedule.date, "2026-07-09");
  assert.deepEqual(ops.currentSchedule("2026-07-10"), todayBefore);
  db.close();
});

test("requires evidence before completing a project deliverable", async () => {
  const { db, tasks, ops, manager } = setup();
  const task = tasks.create({ id: "critical", rawInput: "发布视频", title: "发布视频", status: "doing", requiresEvidence: true });
  const result = await manager.handleAction({ action: "complete", taskId: task.id, idempotencyKey: "complete-1" });

  assert.equal(result.action, "evidence_required");
  assert.equal(tasks.findById(task.id).status, "pending_acceptance");
  assert.equal(ops.listOutbox().at(-1).kind, "evidence_request_card");
  db.close();
});

test("task_dm replanning keeps schedule side effects but does not enqueue a task card", async () => {
  const { db, tasks, ops, manager, scheduled } = setup();
  tasks.create({ id: "quiet-plan", rawInput: "安静排程", status: "ready" });

  const result = await manager.replanDay({ date: "2026-07-10", now: NOW, reason: "checkpoint_09:00", deliveryMode: "task_dm" });

  assert.ok(result.blocks.length > 0);
  assert.ok(scheduled.length > 0);
  assert.equal(ops.listOutbox().some((row) => ["daily_plan_card", "replan_card"].includes(row.kind)), false);
  assert.equal(
    ops.listOutbox().some((row) => ["feishu_task_create", "feishu_task_update"].includes(row.kind)),
    false,
  );
  assert.equal(ops.listEvents().some((event) => event.kind === "schedule_replanned"), true);
  db.close();
});

test("materializes checkpoint blocks before persisting a daily schedule", async () => {
  const { db, tasks, ops, manager } = setup();
  tasks.create({
    id: "timed-task",
    rawInput: "按关卡执行",
    status: "ready",
    estimateMinutes: 60,
    checkpoints: [
      { title: "列提纲", minutes: 20 },
      { title: "写初稿", minutes: 40 },
    ],
  });

  const result = await manager.replanDay({
    date: "2026-07-10",
    now: NOW,
    deliveryMode: "task_dm",
  });

  assert.deepEqual(result.blocks.map((block) => [
    block.checkpointIndex,
    block.startsAt,
    block.endsAt,
  ]), [
    [0, "2026-07-10T02:00:00.000Z", "2026-07-10T02:20:00.000Z"],
    [1, "2026-07-10T02:20:00.000Z", "2026-07-10T03:00:00.000Z"],
  ]);
  assert.deepEqual(
    ops.currentSchedule("2026-07-10").map((block) => block.checkpointIndex),
    [0, 1],
  );
  db.close();
});

test("does not select or remind a task whose checkpoint is outside the work date", async () => {
  const { db, tasks, ops, manager, scheduled } = setup();
  tasks.create({
    id: "tomorrow-checkpoint",
    rawInput: "明日执行",
    status: "ready",
    estimateMinutes: 30,
    checkpoints: [{
      title: "明日关卡",
      minutes: 30,
      startsAt: "2026-07-11T02:00:00.000Z",
      endsAt: "2026-07-11T02:30:00.000Z",
    }],
  });

  const result = await manager.replanDay({
    date: "2026-07-10",
    now: NOW,
    deliveryMode: "task_dm",
  });

  assert.deepEqual(result.blocks, []);
  assert.deepEqual(result.deferred, ["tomorrow-checkpoint"]);
  assert.deepEqual(ops.currentSchedule("2026-07-10"), []);
  assert.equal(tasks.findById("tomorrow-checkpoint").status, "ready");
  assert.deepEqual(scheduled, []);
  db.close();
});

test("late replanning moves stale anchors after lunch and preserves future anchors", async () => {
  const { db, tasks, ops, manager } = setup({
    settings: {
      timezone: "Asia/Shanghai",
      windows: [["10:00", "12:00"], ["14:00", "18:00"]],
      maxCriticalTasks: 3,
      noResponseMinutes: 15,
      projectBoosts: [],
    },
  });
  tasks.create({
    id: "late-anchored-task",
    rawInput: "补做上午任务",
    status: "ready",
    estimateMinutes: 60,
    checkpoints: [
      {
        title: "补做上午动作",
        minutes: 30,
        startsAt: "2026-07-10T02:00:00.000Z",
        endsAt: "2026-07-10T02:30:00.000Z",
      },
      {
        title: "保留下午验收",
        minutes: 30,
        startsAt: "2026-07-10T06:30:00.000Z",
        endsAt: "2026-07-10T07:00:00.000Z",
      },
    ],
  });

  const result = await manager.replanDay({
    date: "2026-07-10",
    now: "2026-07-10T04:00:00.000Z",
    deliveryMode: "task_dm",
  });

  assert.deepEqual(result.blocks.map((block) => [block.checkpointIndex, block.startsAt, block.endsAt]), [
    [0, "2026-07-10T06:00:00.000Z", "2026-07-10T06:30:00.000Z"],
    [1, "2026-07-10T06:30:00.000Z", "2026-07-10T07:00:00.000Z"],
  ]);
  assert.deepEqual(result.blocks, ops.currentSchedule("2026-07-10"));
  assert.equal(result.blocks.some((block) => block.startsAt < "2026-07-10T06:00:00.000Z"), false);
  db.close();
});

test("10:15 catch-up moves a partially elapsed planned checkpoint", async () => {
  const { db, tasks, ops, manager } = setup({
    settings: {
      timezone: "Asia/Shanghai",
      windows: [["10:00", "12:00"]],
      maxCriticalTasks: 3,
      noResponseMinutes: 15,
      projectBoosts: [],
    },
  });
  tasks.create({
    id: "partially-elapsed",
    title: "录制口播",
    rawInput: "录制口播",
    status: "scheduled",
    estimateMinutes: 30,
    checkpoints: [{
      title: "录制第一条口播",
      minutes: 30,
      startsAt: "2026-07-10T02:00:00.000Z",
      endsAt: "2026-07-10T02:30:00.000Z",
    }],
  });
  ops.replaceSchedule({ date: "2026-07-10", blocks: [{
    taskId: "partially-elapsed",
    checkpointIndex: 0,
    startsAt: "2026-07-10T02:00:00.000Z",
    endsAt: "2026-07-10T02:30:00.000Z",
    status: "planned",
    reason: "original plan",
  }] });

  const result = await manager.replanDay({
    date: "2026-07-10",
    now: "2026-07-10T02:15:00.000Z",
    deliveryMode: "task_dm",
  });

  assert.deepEqual(result.blocks.map((block) => [block.startsAt, block.endsAt]), [
    ["2026-07-10T02:15:00.000Z", "2026-07-10T02:45:00.000Z"],
  ]);
  assert.deepEqual(result.blocks, ops.currentSchedule("2026-07-10"));
  db.close();
});

test("12:00 concrete task feedback shrinks remaining scope before real replanning", async () => {
  const { db, tasks, ops, manager } = setup({
    settings: {
      timezone: "Asia/Shanghai",
      windows: [["10:00", "12:00"], ["14:00", "18:00"]],
      maxCriticalTasks: 3,
      noResponseMinutes: 15,
      projectBoosts: [],
    },
  });
  tasks.create({
    id: "delayed-video",
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
        startsAt: "2026-07-10T02:00:00.000Z",
        endsAt: "2026-07-10T02:30:00.000Z",
        completed: true,
      },
      {
        title: "录制3条可剪辑口播",
        minutes: 60,
        startsAt: "2026-07-10T06:00:00.000Z",
        endsAt: "2026-07-10T07:00:00.000Z",
        completed: false,
      },
    ],
  });
  ops.replaceSchedule({
    date: "2026-07-10",
    blocks: [{
      taskId: "delayed-video",
      checkpointIndex: 1,
      startsAt: "2026-07-10T06:00:00.000Z",
      endsAt: "2026-07-10T07:00:00.000Z",
      status: "planned",
      reason: "original scope",
    }],
  });
  const policy = createCheckpointPolicy({
    manager,
    tasks,
    timezone: "Asia/Shanghai",
    getSchedule: (date) => ({ date, blocks: ops.currentSchedule(date) }),
  });

  const result = await policy.apply({
    node: "12:00",
    workDate: "2026-07-10",
    now: "2026-07-10T04:00:00.000Z",
    messages: [{ messageId: "om-delay", content: { text: "来不及拍3条了，今天缩减为先拍1条" } }],
    remoteProgress: { completedTasks: [], completedCheckpoints: [] },
    analysis: { items: [{
      messageIds: ["om-delay"],
      disposition: "task_feedback",
      taskId: "delayed-video",
      title: "缩减为录制1条口播",
      nextAction: "录制1条可剪辑口播",
      doneDefinition: "1条可剪辑原片已提交",
      estimateMinutes: 30,
      checkpoints: [{ title: "录制1条可剪辑口播", minutes: 30 }],
    }] },
  });

  const updated = tasks.findById("delayed-video");
  assert.equal(updated.estimateMinutes, 30);
  assert.equal(updated.nextAction, "录制1条可剪辑口播");
  assert.equal(updated.doneDefinition, "1条可剪辑原片已提交");
  assert.deepEqual(updated.checkpoints, [
    {
      title: "完成3条口播提纲",
      minutes: 30,
      startsAt: "2026-07-10T02:00:00.000Z",
      endsAt: "2026-07-10T02:30:00.000Z",
      completed: true,
    },
    { title: "录制1条可剪辑口播", minutes: 30, completed: false },
  ]);
  assert.deepEqual(result.schedule.blocks.map((block) => [block.checkpointIndex, block.startsAt, block.endsAt]), [
    [1, "2026-07-10T06:00:00.000Z", "2026-07-10T06:30:00.000Z"],
  ]);
  assert.deepEqual(result.schedule.blocks, ops.currentSchedule("2026-07-10"));
  assert.match(result.reply, /改到 14:00–14:30/);
  db.close();
});

test("unknown or vague task feedback stays a candidate and cannot erase scope", async () => {
  const { db, tasks, ops, manager } = setup();
  const original = tasks.create({
    id: "protected-scope",
    title: "个人IP｜完成口播原片",
    rawInput: "完成口播原片",
    status: "scheduled",
    estimateMinutes: 60,
    nextAction: "录制3条口播",
    doneDefinition: "3条可剪辑原片已提交",
    checkpoints: [
      { title: "完成口播提纲", minutes: 30, completed: true },
      { title: "录制3条口播", minutes: 60, completed: false },
    ],
  });
  const policy = createCheckpointPolicy({
    manager,
    tasks,
    timezone: "Asia/Shanghai",
    getSchedule: (date) => ({ date, blocks: ops.currentSchedule(date) }),
  });

  const result = await policy.apply({
    node: "09:00",
    workDate: "2026-07-10",
    now: "2026-07-10T01:00:00.000Z",
    messages: [{ messageId: "om-unknown" }, { messageId: "om-vague" }],
    remoteProgress: { completedTasks: [], completedCheckpoints: [] },
    analysis: { items: [
      {
        disposition: "task_feedback",
        taskId: "missing-task",
        title: "缩减为录制1条口播",
        nextAction: "录制1条可剪辑口播",
        doneDefinition: "1条可剪辑原片已提交",
        estimateMinutes: 30,
        checkpoints: [{ title: "录制1条可剪辑口播", minutes: 30 }],
      },
      {
        disposition: "task_feedback",
        taskId: "protected-scope",
        title: "继续处理",
        nextAction: "处理一下",
        doneDefinition: "完成",
        estimateMinutes: 30,
        checkpoints: [{ title: "处理一下", minutes: 30 }],
      },
    ] },
  });

  assert.deepEqual(tasks.findById("protected-scope"), original);
  assert.equal(result.actions.filter((action) => action.type === "candidate_recorded").length, 2);
  assert.equal(result.actions.some((action) => action.type === "task_feedback"), false);
  db.close();
});

test("task feedback cannot redirect an unrelated referenced message through a model task id", async () => {
  const { db, tasks, ops, manager } = setup();
  const original = tasks.create({
    id: "video-task",
    title: "个人IP｜录制3条口播",
    rawInput: "录制3条口播",
    status: "scheduled",
    estimateMinutes: 60,
    nextAction: "录制3条口播",
    doneDefinition: "3条可剪辑原片已提交",
    checkpoints: [{ title: "录制3条可剪辑口播", minutes: 60, completed: false }],
  });
  tasks.create({
    id: "finance-task",
    title: "极享OS｜完成财务模块对账",
    rawInput: "完成财务模块对账",
    status: "scheduled",
    checkpoints: [{ title: "核对财务模块订单数据", minutes: 30, completed: false }],
  });
  const policy = createCheckpointPolicy({
    manager,
    tasks,
    timezone: "Asia/Shanghai",
    getSchedule: (date) => ({ date, blocks: ops.currentSchedule(date) }),
  });

  const result = await policy.apply({
    node: "09:00",
    workDate: "2026-07-10",
    now: "2026-07-10T01:00:00.000Z",
    messages: [
      { messageId: "om-feedback", content: { text: "财务模块对账今天缩减为只核对订单" } },
      { messageId: "om-unreferenced", content: { text: "录制3条口播今天缩减为先拍1条" } },
    ],
    remoteProgress: { completedTasks: [], completedCheckpoints: [] },
    analysis: { items: [taskFeedback()] },
  });

  assert.deepEqual(tasks.findById("video-task"), original);
  assert.equal(result.actions.some((action) => action.type === "task_feedback"), false);
  assert.equal(result.actions.some((action) => action.type === "candidate_recorded"), true);
  db.close();
});

test("task feedback rejects an ambiguous source shared by two current task titles", async () => {
  const { db, tasks, ops, manager } = setup();
  const original = tasks.create({
    id: "video-task",
    title: "录制3条口播",
    rawInput: "上午录制3条口播",
    status: "scheduled",
    estimateMinutes: 60,
    nextAction: "录制3条口播",
    doneDefinition: "3条可剪辑原片已提交",
    checkpoints: [{ title: "录制3条可剪辑口播", minutes: 60, completed: false }],
  });
  tasks.create({
    id: "second-video-task",
    title: "录制3条口播",
    rawInput: "晚上录制3条口播",
    status: "scheduled",
    estimateMinutes: 60,
    checkpoints: [{ title: "录制3条可剪辑口播", minutes: 60, completed: false }],
  });
  const policy = createCheckpointPolicy({
    manager,
    tasks,
    timezone: "Asia/Shanghai",
    getSchedule: (date) => ({ date, blocks: ops.currentSchedule(date) }),
  });

  const result = await policy.apply({
    node: "09:00",
    workDate: "2026-07-10",
    now: "2026-07-10T01:00:00.000Z",
    messages: [{ messageId: "om-feedback", content: { text: "录制3条口播今天缩减为先拍1条" } }],
    remoteProgress: { completedTasks: [], completedCheckpoints: [] },
    analysis: { items: [taskFeedback()] },
  });

  assert.deepEqual(tasks.findById("video-task"), original);
  assert.equal(result.actions.some((action) => action.type === "task_feedback"), false);
  db.close();
});

test("task feedback never reopens or rewrites pending acceptance scope", async () => {
  const { db, tasks, ops, manager } = setup();
  const original = tasks.create({
    id: "video-task",
    title: "个人IP｜录制3条口播",
    rawInput: "录制3条口播",
    status: "pending_acceptance",
    estimateMinutes: 60,
    nextAction: "录制3条口播",
    doneDefinition: "3条可剪辑原片已提交",
    checkpoints: [{ title: "录制3条可剪辑口播", minutes: 60, completed: false }],
  });
  const policy = createCheckpointPolicy({
    manager,
    tasks,
    timezone: "Asia/Shanghai",
    getSchedule: (date) => ({ date, blocks: ops.currentSchedule(date) }),
  });

  const result = await policy.apply({
    node: "09:00",
    workDate: "2026-07-10",
    now: "2026-07-10T01:00:00.000Z",
    messages: [{ messageId: "om-feedback", content: { text: "录制3条口播今天缩减为先拍1条" } }],
    remoteProgress: { completedTasks: [], completedCheckpoints: [] },
    analysis: { items: [taskFeedback()] },
  });

  assert.deepEqual(tasks.findById("video-task"), original);
  assert.equal(result.actions.some((action) => action.type === "task_feedback"), false);
  db.close();
});

test("task feedback rejects out-of-order completion instead of renumbering checkpoint identity", async () => {
  const { db, tasks, ops, manager } = setup();
  const original = tasks.create({
    id: "video-task",
    title: "个人IP｜录制3条口播",
    rawInput: "录制3条口播",
    status: "scheduled",
    estimateMinutes: 60,
    nextAction: "录制3条口播",
    doneDefinition: "3条可剪辑原片已提交",
    checkpoints: [
      { title: "完成3条口播提纲", minutes: 30, completed: false },
      { title: "录制3条可剪辑口播", minutes: 30, completed: true },
    ],
  });
  const policy = createCheckpointPolicy({
    manager,
    tasks,
    timezone: "Asia/Shanghai",
    getSchedule: (date) => ({ date, blocks: ops.currentSchedule(date) }),
  });

  const result = await policy.apply({
    node: "09:00",
    workDate: "2026-07-10",
    now: "2026-07-10T01:00:00.000Z",
    messages: [{ messageId: "om-feedback", content: { text: "录制3条口播今天缩减为先拍1条" } }],
    remoteProgress: { completedTasks: [], completedCheckpoints: [] },
    analysis: { items: [taskFeedback()] },
  });

  assert.deepEqual(tasks.findById("video-task"), original);
  assert.equal(result.actions.some((action) => action.type === "task_feedback"), false);
  db.close();
});

test("task feedback rejects a structural shrink that would orphan a linked Feishu child", async () => {
  const { db, tasks, ops, manager } = setup();
  const links = createAutomationRepository(db, { now: () => NOW });
  const original = tasks.create({
    id: "video-task",
    title: "个人IP｜录制3条口播",
    rawInput: "录制3条口播",
    status: "scheduled",
    estimateMinutes: 90,
    nextAction: "录制3条口播",
    doneDefinition: "3条可剪辑原片已提交",
    checkpoints: [
      { title: "完成第1条口播", minutes: 30, completed: false },
      { title: "完成第2条口播", minutes: 30, completed: false },
      { title: "完成第3条口播", minutes: 30, completed: false },
    ],
  });
  links.upsertFeishuLink({
    localTaskId: "video-task",
    checkpointIndex: 2,
    taskGuid: "child-2",
    parentGuid: "parent-1",
    snapshotHash: "old",
  });
  const policy = createCheckpointPolicy({
    manager,
    tasks,
    links,
    timezone: "Asia/Shanghai",
    getSchedule: (date) => ({ date, blocks: ops.currentSchedule(date) }),
  });

  const result = await policy.apply({
    node: "09:00",
    workDate: "2026-07-10",
    now: "2026-07-10T01:00:00.000Z",
    messages: [{ messageId: "om-feedback", content: { text: "录制3条口播今天缩减为只录2条" } }],
    remoteProgress: { completedTasks: [], completedCheckpoints: [] },
    analysis: { items: [taskFeedback({
      title: "缩减为录制2条口播",
      nextAction: "录制2条可剪辑口播",
      doneDefinition: "2条可剪辑原片已提交",
      estimateMinutes: 60,
      checkpoints: [
        { title: "完成第1条可剪辑口播", minutes: 30 },
        { title: "完成第2条可剪辑口播", minutes: 30 },
      ],
    })] },
  });

  assert.deepEqual(tasks.findById("video-task"), original);
  assert.equal(result.actions.some((action) => action.type === "task_feedback"), false);
  assert.equal(links.findFeishuLink("video-task", 2).taskGuid, "child-2");
  db.close();
});

test("pure postponement feedback cannot rewrite scope until rescheduling is supported", async () => {
  const { db, tasks, ops, manager } = setup();
  const original = tasks.create({
    id: "video-task",
    title: "个人IP｜录制3条口播",
    rawInput: "录制3条口播",
    status: "scheduled",
    estimateMinutes: 60,
    nextAction: "录制3条口播",
    doneDefinition: "3条可剪辑原片已提交",
    checkpoints: [{ title: "录制3条可剪辑口播", minutes: 60, completed: false }],
  });
  const policy = createCheckpointPolicy({
    manager,
    tasks,
    timezone: "Asia/Shanghai",
    getSchedule: (date) => ({ date, blocks: ops.currentSchedule(date) }),
  });

  const result = await policy.apply({
    node: "09:00",
    workDate: "2026-07-10",
    now: "2026-07-10T01:00:00.000Z",
    messages: [{ messageId: "om-feedback", content: { text: "录制3条口播改到20点" } }],
    remoteProgress: { completedTasks: [], completedCheckpoints: [] },
    analysis: { items: [taskFeedback()] },
  });

  assert.deepEqual(tasks.findById("video-task"), original);
  assert.equal(result.actions.some((action) => action.type === "task_feedback"), false);
  assert.equal(result.actions.some((action) => action.type === "candidate_recorded"), true);
  db.close();
});

test("24:00 review defers scope feedback instead of committing an unreplanned task", async () => {
  const { db, tasks, ops, manager } = setup();
  const original = tasks.create({
    id: "video-task",
    title: "个人IP｜录制3条口播",
    rawInput: "录制3条口播",
    status: "scheduled",
    estimateMinutes: 60,
    nextAction: "录制3条口播",
    doneDefinition: "3条可剪辑原片已提交",
    checkpoints: [{ title: "录制3条可剪辑口播", minutes: 60, completed: false }],
  });
  const policy = createCheckpointPolicy({
    manager,
    tasks,
    timezone: "Asia/Shanghai",
    getSchedule: (date) => ({ date, blocks: ops.currentSchedule(date) }),
  });

  const result = await policy.apply({
    node: "24:00",
    workDate: "2026-07-10",
    now: "2026-07-10T16:00:00.000Z",
    messages: [{ messageId: "om-feedback", content: { text: "来不及拍3条了，先拍1条" } }],
    remoteProgress: { completedTasks: [], completedCheckpoints: [] },
    analysis: { items: [taskFeedback()] },
  });

  assert.deepEqual(tasks.findById("video-task"), original);
  assert.equal(ops.listEvents({ taskId: "video-task", kind: "task_feedback_applied" }).length, 0);
  assert.equal(result.actions.some((action) => action.type === "candidate_recorded"
    && action.reason === "task_feedback_rejected_at_review"), true);
  assert.match(result.reply, /任务范围反馈未应用/);
  db.close();
});

test("12:00 policy puts a new today disposition into the real capacity-limited schedule", async () => {
  const { db, tasks, ops, manager } = setup();
  const policy = createCheckpointPolicy({ manager, tasks });

  const result = await policy.apply({
    node: "12:00", workDate: "2026-07-10", messages: [{ messageId: "om-real-12" }],
    remoteProgress: { completedTasks: [], completedCheckpoints: [] },
    analysis: { items: [{
      disposition: "schedule_today", title: "真实午间排程", estimateMinutes: 30,
      checkpoints: [{ title: "导出午间脚本", minutes: 30 }],
    }] },
  });

  assert.equal(result.schedule.blocks.some((block) => block.taskId === tasks.findByTitle("真实午间排程")[0].id), true);
  assert.equal(ops.listOutbox().some((row) => row.kind === "replan_card"), false);
  db.close();
});

test("15:00 policy preserves real doing work and schedules the new today task", async () => {
  const { db, tasks, manager } = setup();
  const doing = tasks.create({ id: "real-doing", rawInput: "当前核心任务", status: "doing", estimateMinutes: 30 });
  await manager.replanDay({ date: "2026-07-10", now: NOW, deliveryMode: "task_dm" });
  const policy = createCheckpointPolicy({ manager, tasks });

  const result = await policy.apply({
    node: "15:00", workDate: "2026-07-10", messages: [{ messageId: "om-real-15" }],
    remoteProgress: { completedTasks: [], completedCheckpoints: [] },
    analysis: { items: [{
      disposition: "schedule_today", title: "真实下午排程", estimateMinutes: 30,
      checkpoints: [{ title: "导出下午交付", minutes: 30 }],
    }] },
  });

  const created = tasks.findByTitle("真实下午排程")[0];
  assert.equal(result.schedule.blocks[0].taskId, doing.id);
  assert.equal(result.schedule.blocks.some((block) => block.taskId === created.id), true);
  db.close();
});

test("18:00 policy persists the same one-outcome schedule it returns after remote progress", async () => {
  const { db, tasks, ops, manager } = setup();
  tasks.create({
    id: "evening-current",
    rawInput: "完成晚间关键交付",
    title: "完成晚间关键交付",
    status: "doing",
    estimateMinutes: 60,
    checkpoints: [
      { title: "完成第一阶段", minutes: 30 },
      { title: "导出最终交付", minutes: 30 },
    ],
  });
  tasks.create({
    id: "evening-extra",
    rawInput: "整理低价值素材",
    title: "整理低价值素材",
    status: "ready",
    estimateMinutes: 30,
    checkpoints: [{ title: "整理素材", minutes: 30 }],
  });
  await manager.replanDay({ date: "2026-07-10", now: NOW, deliveryMode: "task_dm" });
  const policy = createCheckpointPolicy({
    manager,
    tasks,
    getSchedule: (date) => ({ date, blocks: ops.currentSchedule(date) }),
  });

  const result = await policy.apply({
    node: "18:00",
    workDate: "2026-07-10",
    messages: [],
    analysis: { items: [] },
    remoteProgress: {
      completedTasks: [],
      completedCheckpoints: [{
        localTaskId: "evening-current",
        checkpointIndex: 0,
        completedAt: "2026-07-10T10:00:00.000Z",
      }],
    },
  });

  assert.equal(new Set(result.schedule.blocks.map((block) => block.taskId)).size, 1);
  assert.deepEqual(result.schedule.blocks, ops.currentSchedule("2026-07-10"));
  db.close();
});

test("silent task_dm action queues no standalone owner message", async () => {
  const { db, tasks, ops, manager } = setup();
  tasks.create({ id: "remote-done", rawInput: "远端完成", status: "doing" });

  await manager.handleAction({ action: "complete", taskId: "remote-done", idempotencyKey: "feishu-parent:1", deliveryMode: "task_dm", suppressOutbox: true });

  assert.equal(ops.listOutbox().some((row) => row.kind === "replan_card"), false);
  assert.equal(ops.listOutbox().some((row) => row.kind === "status_message"), false);
  db.close();
});

test("task_dm completion does not enqueue a legacy task update", async () => {
  const { db, tasks, ops, manager } = setup();
  tasks.create({ id: "remote-done", rawInput: "远端完成", status: "doing" });
  ops.setSetting("feishu_task_guid:remote-done", "remote-guid");

  await manager.handleAction({
    action: "complete",
    taskId: "remote-done",
    idempotencyKey: "managed-complete:1",
    deliveryMode: "task_dm",
    suppressOutbox: true,
  });

  assert.equal(
    ops.listOutbox().some((row) => ["feishu_task_create", "feishu_task_update"].includes(row.kind)),
    false,
  );
  db.close();
});

test("silent evidence-gated completion preserves acceptance without an evidence card", async () => {
  const { db, tasks, ops, manager } = setup();
  tasks.create({ id: "silent-evidence", rawInput: "证据交付", status: "doing", requiresEvidence: true });

  const result = await manager.handleAction({ action: "complete", taskId: "silent-evidence", idempotencyKey: "feishu-parent:evidence", deliveryMode: "task_dm", suppressOutbox: true });

  assert.equal(result.action, "evidence_required");
  assert.equal(tasks.findById("silent-evidence").status, "pending_acceptance");
  assert.equal(ops.listOutbox().some((row) => row.kind === "evidence_request_card"), false);
  db.close();
});

test("silent checkpoint completion queues no standalone status", async () => {
  const { db, tasks, ops, manager } = setup();
  tasks.create({ id: "silent-child", rawInput: "关卡", status: "doing", checkpoints: ["写脚本"] });

  await manager.handleAction({ action: "complete_checkpoint", taskId: "silent-child", checkpointIndex: 0, idempotencyKey: "feishu-child:1", suppressOutbox: true });

  assert.equal(tasks.findById("silent-child").checkpoints[0].completed, true);
  assert.equal(ops.listOutbox().some((row) => row.kind === "status_message"), false);
  db.close();
});

test("checkpoint policy consumes pulled parent progress and routes evidence tasks to pending acceptance", async () => {
  const { db, tasks, ops, manager } = setup();
  tasks.create({ id: "pulled-deliverable", rawInput: "发布交付", status: "doing", requiresEvidence: true });
  const policy = createCheckpointPolicy({ manager, tasks });

  const result = await policy.apply({
    node: "12:00",
    workDate: "2026-07-10",
    messages: [],
    analysis: { items: [] },
    remoteProgress: {
      completedTasks: [{ localTaskId: "pulled-deliverable", completedAt: "2026-07-10T03:00:00.000Z" }],
      completedCheckpoints: [],
    },
  });

  assert.equal(tasks.findById("pulled-deliverable").status, "pending_acceptance");
  assert.equal(result.actions.some((action) => action.type === "parent_completed"), true);
  assert.equal(ops.findEventByIdempotencyKey("feishu-parent:pulled-deliverable:2026-07-10T03:00:00.000Z").kind, "acceptance_requested");
  db.close();
});

test("checkpoint policy gives same-time pulled checkpoint completions distinct idempotency keys", async () => {
  const { db, tasks, ops, manager } = setup();
  tasks.create({ id: "pulled-checkpoints", rawInput: "拍摄交付", status: "doing", checkpoints: ["写脚本", "拍素材"] });
  const policy = createCheckpointPolicy({ manager, tasks });
  const completedAt = "2026-07-10T03:00:00.000Z";

  await policy.apply({
    node: "12:00",
    workDate: "2026-07-10",
    messages: [],
    analysis: { items: [] },
    remoteProgress: {
      completedTasks: [],
      completedCheckpoints: [
        { localTaskId: "pulled-checkpoints", checkpointIndex: 0, completedAt },
        { localTaskId: "pulled-checkpoints", checkpointIndex: 1, completedAt },
      ],
    },
  });

  assert.deepEqual(tasks.findById("pulled-checkpoints").checkpoints.map((checkpoint) => checkpoint.completed), [true, true]);
  assert.equal(ops.findEventByIdempotencyKey(`feishu-checkpoint:pulled-checkpoints:0:${completedAt}`).kind, "checkpoint_completed");
  assert.equal(ops.findEventByIdempotencyKey(`feishu-checkpoint:pulled-checkpoints:1:${completedAt}`).kind, "checkpoint_completed");
  db.close();
});

test("completes one checkpoint without completing the parent task", async () => {
  const { db, tasks, ops, manager } = setup();
  const task = tasks.create({
    id: "task-checkpoint",
    rawInput: "拍摄口播",
    status: "doing",
    checkpoints: ["写脚本", "录制素材"],
  });
  const result = await manager.handleAction({
    action: "complete_checkpoint",
    taskId: task.id,
    checkpointIndex: 0,
    idempotencyKey: "card:checkpoint-1",
  });

  assert.equal(result.task.status, "doing");
  assert.equal(result.task.checkpoints[0].completed, true);
  assert.equal(result.task.checkpoints[1].completed, false);
  assert.ok(Array.isArray(result.schedule.blocks));
  assert.equal(ops.listEvents({ taskId: task.id }).some((event) => event.kind === "checkpoint_completed"), true);
  db.close();
});

test("early checkpoint completion adds at most one task while preserving the current doing block", async () => {
  const settings = {
    timezone: "Asia/Shanghai",
    windows: [["10:00", "12:00"], ["14:00", "18:00"], ["20:00", "22:00"]],
    maxCriticalTasks: 5,
    noResponseMinutes: 15,
    projectBoosts: [],
  };
  const { db, tasks, ops, manager } = setup({ settings });
  const current = tasks.create({
    id: "early-current",
    title: "完成当前核心交付",
    rawInput: "完成当前核心交付",
    status: "doing",
    importance: "A",
    urgency: "high",
    estimateMinutes: 60,
    checkpoints: [
      { title: "完成第一关", minutes: 30 },
      { title: "导出当前交付", minutes: 30 },
    ],
  });
  for (let index = 1; index <= 4; index += 1) {
    tasks.create({
      id: `early-next-${index}`,
      title: `高价值候选 ${index}`,
      rawInput: `高价值候选 ${index}`,
      status: "ready",
      importance: "A",
      urgency: "high",
      estimateMinutes: 30,
      checkpoints: [{ title: `交付候选 ${index}`, minutes: 30 }],
    });
  }

  await manager.replanDay({
    date: "2026-07-10",
    now: NOW,
    deliveryMode: "task_dm",
    maxCriticalTasks: 3,
  });
  const before = ops.currentSchedule("2026-07-10");
  const beforeTaskIds = new Set(before.map((block) => block.taskId));
  const doingBefore = before.find((block) => block.status === "doing");
  assert.equal(beforeTaskIds.size, 3);
  assert.equal(doingBefore.taskId, current.id);

  const result = await manager.handleAction({
    action: "complete_checkpoint",
    taskId: current.id,
    checkpointIndex: 0,
    idempotencyKey: "early-completion:1",
    deliveryMode: "task_dm",
    suppressOutbox: true,
  });

  const afterTaskIds = new Set(result.schedule.blocks.map((block) => block.taskId));
  const introducedTaskIds = [...afterTaskIds].filter((taskId) => !beforeTaskIds.has(taskId));
  const doingAfter = result.schedule.blocks.find((block) => block.status === "doing");
  assert.ok(introducedTaskIds.length <= 1);
  assert.ok(afterTaskIds.size <= beforeTaskIds.size + 1);
  assert.equal(afterTaskIds.has(current.id), true);
  assert.equal(doingAfter.taskId, doingBefore.taskId);
  assert.equal(doingAfter.startsAt, doingBefore.startsAt);
  assert.equal(doingAfter.status, "doing");
  db.close();
});

test("requires a reason before deferring a task", async () => {
  const { db, tasks, ops, manager } = setup();
  const task = tasks.create({ id: "task-defer", rawInput: "拍视频", status: "doing" });
  const result = await manager.handleAction({ action: "defer_30", taskId: task.id, idempotencyKey: "message:defer-1" });

  assert.equal(result.action, "defer_reason_required");
  assert.equal(tasks.findById(task.id).status, "doing");
  assert.match(ops.listOutbox().at(-1).payload.text, /说明推迟原因/);
  db.close();
});

test("does not start a second task while one is doing", async () => {
  const { db, tasks, ops, manager } = setup();
  tasks.create({ id: "current", rawInput: "当前任务", status: "doing" });
  tasks.create({ id: "next", rawInput: "下一个任务", status: "ready" });
  const result = await manager.handleAction({ action: "start", taskId: "next", idempotencyKey: "card:evt-2" });

  assert.equal(result.action, "current_task_conflict");
  assert.equal(tasks.findById("next").status, "ready");
  assert.equal(ops.listOutbox().at(-1).kind, "current_task_conflict");
  db.close();
});

test("starting the current doing task is idempotent and gives visible feedback", async () => {
  const { db, tasks, ops, manager } = setup();
  tasks.create({ id: "current", title: "拍视频", rawInput: "拍视频", status: "doing" });

  const result = await manager.handleAction({
    action: "start",
    taskId: "current",
    idempotencyKey: "card:evt-repeat-start",
  });

  assert.equal(result.action, "already_started");
  assert.equal(result.task.status, "doing");
  assert.match(ops.listOutbox().at(-1).payload.text, /已经在进行中/);
  db.close();
});

test("asks for disambiguation when a text title matches two tasks", async () => {
  const { db, tasks, ops, manager } = setup();
  tasks.create({ id: "a", title: "拍视频第一批", rawInput: "拍视频第一批", status: "ready" });
  tasks.create({ id: "b", title: "拍视频第二批", rawInput: "拍视频第二批", status: "ready" });
  const result = await manager.handleAction({ action: "complete", query: "拍视频", idempotencyKey: "message:om-2" });

  assert.equal(result.action, "disambiguation");
  assert.equal(tasks.findById("a").status, "ready");
  assert.equal(tasks.findById("b").status, "ready");
  assert.equal(ops.listOutbox().at(-1).kind, "disambiguation_card");
  db.close();
});

test("silent action does not enqueue a disambiguation card for an ambiguous task", async () => {
  const { db, tasks, ops, manager } = setup();
  tasks.create({ id: "silent-a", title: "拍视频第一批", rawInput: "拍视频第一批", status: "ready" });
  tasks.create({ id: "silent-b", title: "拍视频第二批", rawInput: "拍视频第二批", status: "ready" });

  const result = await manager.handleAction({
    action: "complete",
    query: "拍视频",
    idempotencyKey: "message:silent-ambiguous",
    suppressOutbox: true,
  });

  assert.equal(result.action, "disambiguation");
  assert.equal(result.matches.length, 2);
  assert.equal(ops.listOutbox().some((row) => row.kind === "disambiguation_card"), false);
  db.close();
});

test("not-found action gives visible feedback in normal mode", async () => {
  const { db, ops, manager } = setup();

  const result = await manager.handleAction({
    action: "complete",
    taskId: "missing-task",
    idempotencyKey: "message:missing-normal",
  });

  assert.equal(result.action, "not_found");
  assert.equal(ops.listOutbox().at(-1).kind, "status_message");
  assert.match(ops.listOutbox().at(-1).payload.text, /missing-task/);
  db.close();
});

test("silent action does not enqueue a status message for a missing task", async () => {
  const { db, ops, manager } = setup();

  const result = await manager.handleAction({
    action: "complete",
    taskId: "silent-missing-task",
    idempotencyKey: "message:missing-silent",
    suppressOutbox: true,
  });

  assert.equal(result.action, "not_found");
  assert.equal(ops.listOutbox().some((row) => row.kind === "status_message"), false);
  db.close();
});

test("blocks proactively without counting procrastination and creates minimum action", async () => {
  const { db, tasks, ops, manager } = setup();
  tasks.create({ id: "task-3", title: "写口播", rawInput: "写口播", status: "doing", procrastinationCount: 0 });
  const result = await manager.handleAction({
    action: "block",
    taskId: "task-3",
    detail: "AI感强",
    idempotencyKey: "message:om-3",
  });

  assert.equal(result.task.status, "blocked");
  assert.equal(result.task.procrastinationCount, 0);
  assert.equal(ops.listOutbox().some((row) => row.kind === "intervention_card"), true);
  db.close();
});
