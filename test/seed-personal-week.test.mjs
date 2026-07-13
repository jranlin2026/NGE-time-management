import assert from "node:assert/strict";
import test from "node:test";
import { openDatabase } from "../src/db/database.mjs";
import { createOperationsRepository } from "../src/db/operations-repository.mjs";
import { createTaskRepository } from "../src/db/task-repository.mjs";
import { seedPersonalWeek } from "../scripts/seed-personal-week.mjs";

const WORK_DATE = "2026-07-13";
const NOW = "2026-07-13T00:00:00.000Z";

function setup({ now = () => NOW } = {}) {
  const db = openDatabase(":memory:");
  let sequence = 0;
  const id = () => `seed-test-${++sequence}`;
  return {
    db,
    tasks: createTaskRepository(db, { now, id }),
    ops: createOperationsRepository(db, { now, id }),
  };
}

test("seeds the four approved personal outcomes idempotently", (t) => {
  let now = NOW;
  const { db, tasks, ops } = setup({ now: () => now });
  t.after(() => db.close());

  seedPersonalWeek({ tasks, ops, workDate: WORK_DATE });
  const firstUpdatedAt = new Map(tasks.listAll().map((task) => [task.id, task.updatedAt]));
  now = "2026-07-13T00:05:00.000Z";
  seedPersonalWeek({ tasks, ops, workDate: WORK_DATE });

  assert.equal(tasks.listActive().filter((task) => task.dueAt === WORK_DATE).length, 4);
  assert.equal(tasks.findById("wk20260713-personal-ip").checkpoints.length, 4);
  assert.equal(tasks.findById("wk20260713-public-live").estimateMinutes, 60);
  assert.equal(
    tasks.findById("wk20260713-public-live").checkpoints.some((item) => item.title.includes("直播14小时")),
    false,
  );
  assert.equal(new Set(tasks.listAll().map((task) => task.id)).size, tasks.listAll().length);
  assert.deepEqual(
    new Map(tasks.listAll().map((task) => [task.id, task.updatedAt])),
    firstUpdatedAt,
  );
});

test("rewrites stale stable rows to the approved actions, standards, estimates, and checkpoints", (t) => {
  const { db, tasks, ops } = setup();
  t.after(() => db.close());
  tasks.create({
    id: "wk20260713-jxos-leads",
    title: "极享OS｜旧标题",
    project: "旧项目",
    dueAt: WORK_DATE,
    status: "ready",
    nextAction: "旧动作",
    doneDefinition: "旧标准",
    estimateMinutes: 5,
    checkpoints: [{ title: "旧检查点", completed: true }],
  });
  tasks.create({
    id: "wk20260713-public-live",
    title: "公域直播｜你直播14小时",
    project: "旧项目",
    dueAt: WORK_DATE,
    status: "ready",
    nextAction: "旧动作",
    doneDefinition: "旧标准",
    estimateMinutes: 840,
    checkpoints: [{ title: "直播14小时", completed: true }],
  });

  seedPersonalWeek({ tasks, ops, workDate: WORK_DATE });

  const jxos = tasks.findById("wk20260713-jxos-leads");
  assert.equal(jxos.title, "极享OS｜验收线索模块并完成1名员工真实迁移");
  assert.equal(jxos.project, "极享OS");
  assert.equal(jxos.estimateMinutes, 120);
  assert.equal(jxos.nextAction, "确认线索字段、权限与操作流程");
  assert.equal(
    jxos.doneDefinition,
    "员工能独立完成主流程；阻断问题为零；非阻断问题进入问题清单并明确负责人和时间。",
  );
  assert.deepEqual(jxos.checkpoints, [
    {
      title: "确认线索字段、权限与操作流程",
      minutes: 30,
      startsAt: "2026-07-13T06:00:00.000Z",
      endsAt: "2026-07-13T06:30:00.000Z",
      doneDefinition: "字段、权限与流程可执行",
      completed: false,
    },
    {
      title: "完成新增、分配、跟进和查询抽测",
      minutes: 45,
      startsAt: "2026-07-13T06:30:00.000Z",
      endsAt: "2026-07-13T07:15:00.000Z",
      doneDefinition: "主流程抽测全部通过",
      completed: false,
    },
    {
      title: "让1名员工完成真实线索操作并记录问题",
      minutes: 45,
      startsAt: "2026-07-13T07:15:00.000Z",
      endsAt: "2026-07-13T08:00:00.000Z",
      doneDefinition: "1名员工完成真实线索操作",
      completed: false,
    },
  ]);

  const publicLive = tasks.findById("wk20260713-public-live");
  assert.equal(publicLive.title, "公域直播｜完成开播检查与30单结果复盘");
  assert.equal(publicLive.project, "公域直播");
  assert.equal(publicLive.estimateMinutes, 60);
  assert.equal(publicLive.nextAction, "确认三主播排班、货盘和成交口径");
  assert.equal(
    publicLive.doneDefinition,
    "完成开播检查并输出30单结果与纠偏动作",
  );
  assert.deepEqual(
    publicLive.checkpoints.map(({ title, minutes, completed }) => ({ title, minutes, completed })),
    [
      { title: "确认三主播排班、货盘和成交口径", minutes: 15, completed: false },
      { title: "检查中场订单数据并只处理关键阻塞", minutes: 15, completed: false },
      { title: "记录实际订单、差距和明日唯一纠偏动作", minutes: 30, completed: false },
    ],
  );
});

test("preserves legitimate task and matching checkpoint progress on reseed", (t) => {
  const { db, tasks, ops } = setup();
  t.after(() => db.close());
  seedPersonalWeek({ tasks, ops, workDate: WORK_DATE });

  const personalIp = tasks.findById("wk20260713-personal-ip");
  tasks.update(personalIp.id, {
    status: "done",
    checkpoints: personalIp.checkpoints.map((checkpoint, index) => ({
      ...checkpoint,
      completed: index === 0,
    })),
  });
  const jxos = tasks.findById("wk20260713-jxos-leads");
  tasks.update(jxos.id, {
    status: "doing",
    checkpoints: [
      { ...jxos.checkpoints[0], completed: true },
      { title: "无关旧检查点", completed: true },
    ],
  });

  seedPersonalWeek({ tasks, ops, workDate: WORK_DATE });

  const reseededIp = tasks.findById(personalIp.id);
  assert.equal(reseededIp.status, "done");
  assert.equal(reseededIp.checkpoints[0].completed, true);
  const reseededJxos = tasks.findById(jxos.id);
  assert.equal(reseededJxos.status, "doing");
  assert.equal(reseededJxos.checkpoints[0].completed, true);
  assert.equal(reseededJxos.checkpoints.slice(1).some((checkpoint) => checkpoint.completed), false);
});

test("cancels superseded active work without deleting it or duplicating its event", (t) => {
  const { db, tasks, ops } = setup();
  t.after(() => db.close());
  tasks.create({ id: "old-plan", title: "旧版全天任务", dueAt: WORK_DATE, status: "ready" });
  tasks.create({ id: "historical", title: "已完成历史任务", dueAt: WORK_DATE, status: "done" });

  seedPersonalWeek({ tasks, ops, workDate: WORK_DATE });
  seedPersonalWeek({ tasks, ops, workDate: WORK_DATE });

  assert.equal(tasks.findById("old-plan").status, "cancelled");
  assert.equal(tasks.findById("historical").status, "done");
  const events = ops.listEvents({ taskId: "old-plan", kind: "task_superseded_by_clear_plan" });
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].payload, { workDate: WORK_DATE, replacementTaskIds: [
    "wk20260713-personal-ip",
    "wk20260713-jxos-leads",
    "wk20260713-public-live",
    "wk20260713-private-live",
  ] });
});
