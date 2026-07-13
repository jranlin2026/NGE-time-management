# Personal Task and DM Experience Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Feishu show one clear outcome task with timed subtasks for each N哥-owned result, and make the bot DM a complete executable day plan plus change-only checkpoint updates.

**Architecture:** SQLite remains the source of truth. `schedule_blocks` gains checkpoint identity, a new pure execution-brief renderer turns one schedule into user-facing text, and `feishu-task-sync` becomes the only fixed-checkpoint task writer. Live cleanup happens only after automated tests prove single-writer idempotency.

**Tech Stack:** Node.js 24, native `node:sqlite`, Node test runner, Feishu Task v2 OpenAPI, Codex local automations, Markdown runbooks.

## Global Constraints

- This project manages N哥 only; team members' execution time never becomes a personal task block.
- A parent task is one verifiable outcome; a child task is one timed executable step.
- Parent titles use `项目｜动作 + 可验收结果` and do not repeat the work date.
- Normal days contain 3–4 parent outcomes; 5 is a hard maximum.
- 08:00 sends the full plan; 09/12/15/18/21 send only changed facts and actions; 24:00 sends the review.
- Ongoing work is protected; ordinary new inputs cannot interrupt it.
- `feishu-task-sync` is the only writer for fixed-checkpoint Feishu tasks.
- Never delete Feishu tasks by title; live deletion requires verified GUID membership and a database backup.
- Keep `Luna + medium` for the outer automation; set checkpoint message analysis to `gpt-5.6-terra + high` after code validation.
- Every production change follows red-green-refactor and ends with focused tests plus the full test suite.

---

### Task 1: Remove the Legacy Fixed-Checkpoint Task Writer

**Files:**
- Modify: `src/lib/manager-service.mjs`
- Modify: `test/manager-service.test.mjs`
- Modify: `test/checkpoint-e2e.test.mjs`

**Interfaces:**
- Consumes: `manager.replanDay({ deliveryMode: "task_dm" })` and `manager.handleAction({ deliveryMode: "task_dm" })`.
- Produces: fixed-checkpoint replans that persist schedules and reminders without creating legacy `feishu_task_create` or `feishu_task_update` outbox rows.

- [ ] **Step 1: Write failing manager tests**

Add assertions to the existing `task_dm` tests:

```js
assert.equal(
  ops.listOutbox().some((row) => ["feishu_task_create", "feishu_task_update"].includes(row.kind)),
  false,
);
```

Add a completion test that calls:

```js
await manager.handleAction({
  action: "complete",
  taskId: "remote-done",
  idempotencyKey: "managed-complete:1",
  deliveryMode: "task_dm",
  suppressOutbox: true,
});
```

and asserts no legacy task outbox row exists.

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node --test test/manager-service.test.mjs
```

Expected: FAIL because `replanDay()` still enqueues `feishu_task_create` and completion still enqueues `feishu_task_update`.

- [ ] **Step 3: Gate legacy task outbox writes**

In `replanDay()` change the old creation guard to:

```js
if (options.deliveryMode !== "task_dm" && !ops.getSetting(`feishu_task_guid:${taskId}`)) {
  ops.enqueueOutbox({
    kind: "feishu_task_create",
    payload: {
      action: "create",
      localTaskId: taskId,
      task: {
        summary: selectedTask.title,
        description: `${selectedTask.nextAction}\n\n完成标准：${selectedTask.doneDefinition}`,
        dueDate: selectedTask.dueAt?.slice(0, 10) || scheduleDate,
      },
    },
    idempotencyKey: `feishu-task-create:${taskId}`,
  });
}
```

In `handleAction()` change completion sync to:

```js
if (input.action === "complete" && input.deliveryMode !== "task_dm") {
  enqueueFeishuTaskCompletion(updated);
}
```

- [ ] **Step 4: Add an integrated single-writer assertion**

In `test/checkpoint-e2e.test.mjs`, make the fake outbox sender fail if it receives either legacy task kind:

```js
if (["feishu_task_create", "feishu_task_update"].includes(row.kind)) {
  assert.fail(`legacy task outbox reached checkpoint flow: ${row.kind}`);
}
```

Run:

```bash
/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node --test test/manager-service.test.mjs test/checkpoint-e2e.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/manager-service.mjs test/manager-service.test.mjs test/checkpoint-e2e.test.mjs
git commit -m "fix: use one Feishu task writer for checkpoints"
```

---

### Task 2: Persist Timed Checkpoint Blocks

**Files:**
- Modify: `src/db/database.mjs`
- Modify: `src/db/operations-repository.mjs`
- Modify: `src/db/task-repository.mjs`
- Modify: `test/database.test.mjs`
- Modify: `test/task-repository.test.mjs`

**Interfaces:**
- Produces: schedule block shape `{ taskId, checkpointIndex, startsAt, endsAt, status, reason }`.
- Produces: checkpoint shape `{ title, minutes, startsAt, endsAt, doneDefinition, feedback, completed }`.
- Preserves: old rows map `checkpointIndex` to `null`; old checkpoint JSON remains readable.

- [ ] **Step 1: Write failing migration and round-trip tests**

Add:

```js
test("migration six adds checkpoint identity to schedule blocks", () => {
  const db = openDatabase(":memory:");
  const columns = db.prepare("PRAGMA table_info(schedule_blocks)").all().map((row) => row.name);
  assert.ok(columns.includes("checkpoint_index"));
  assert.ok(db.prepare("SELECT 1 FROM schema_migrations WHERE version = 6").get());
  db.close();
});
```

Add a task repository test that creates:

```js
checkpoints: [{
  title: "确定3个选题",
  minutes: 20,
  startsAt: "2026-07-13T02:15:00.000Z",
  endsAt: "2026-07-13T02:35:00.000Z",
  doneDefinition: "3个选题和钩子已确认",
  feedback: "在飞书勾选并附选题清单",
}]
```

and asserts every field survives create/read/update.

- [ ] **Step 2: Run focused tests and verify RED**

```bash
/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node --test test/database.test.mjs test/task-repository.test.mjs
```

Expected: FAIL because migration 6 and checkpoint fields do not exist.

- [ ] **Step 3: Add migration 6 and repository mappings**

In `database.mjs` add:

```js
const MIGRATION_6 = `
ALTER TABLE schedule_blocks ADD COLUMN checkpoint_index INTEGER;
CREATE INDEX idx_blocks_checkpoint ON schedule_blocks(schedule_date, task_id, checkpoint_index);
`;
```

Append it to the migration list.

In `operations-repository.mjs`, insert and map `checkpoint_index`:

```js
insert.run(
  id(), date, version, block.taskId, block.checkpointIndex ?? null,
  block.startsAt, block.endsAt, block.status || "planned", block.reason, now(),
);
```

In `normalizeCheckpoints()`, preserve the detailed fields only when valid strings:

```js
{
  title: clean(checkpoint?.title),
  ...(Number.isInteger(checkpoint?.minutes) ? { minutes: checkpoint.minutes } : {}),
  ...(checkpoint?.startsAt ? { startsAt: String(checkpoint.startsAt) } : {}),
  ...(checkpoint?.endsAt ? { endsAt: String(checkpoint.endsAt) } : {}),
  ...(checkpoint?.doneDefinition ? { doneDefinition: clean(checkpoint.doneDefinition) } : {}),
  ...(checkpoint?.feedback ? { feedback: clean(checkpoint.feedback) } : {}),
  completed: Boolean(checkpoint?.completed),
}
```

- [ ] **Step 4: Verify focused and full tests**

```bash
/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node --test test/database.test.mjs test/task-repository.test.mjs
/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node --test
```

Expected: PASS; all legacy migration tests remain green.

- [ ] **Step 5: Commit**

```bash
git add src/db/database.mjs src/db/operations-repository.mjs src/db/task-repository.mjs test/database.test.mjs test/task-repository.test.mjs
git commit -m "feat: persist timed checkpoint blocks"
```

---

### Task 3: Materialize Timed Checkpoints into the Daily Schedule

**Files:**
- Create: `src/lib/checkpoint-scheduler.mjs`
- Create: `test/checkpoint-scheduler.test.mjs`
- Modify: `src/lib/manager-service.mjs`
- Modify: `test/manager-service.test.mjs`

**Interfaces:**
- Consumes: task-level schedule blocks plus detailed checkpoints from Task 2.
- Produces: `materializeCheckpointSchedule({ schedule, tasks, date, timezone }) -> schedule` where executable blocks carry `checkpointIndex`.
- Rejects: overlapping explicit checkpoint intervals and checkpoints outside the requested work date.

- [ ] **Step 1: Write failing checkpoint materialization tests**

Create one parent block and a task with four checkpoints, two of which use non-contiguous explicit times. Assert:

```js
const result = materializeCheckpointSchedule({ schedule, tasks: [task], date: "2026-07-13", timezone: "Asia/Shanghai" });
assert.deepEqual(result.blocks.map((block) => block.checkpointIndex), [0, 1, 2, 3]);
assert.deepEqual(result.blocks.map((block) => [block.startsAt, block.endsAt]), [
  ["2026-07-13T02:15:00.000Z", "2026-07-13T02:35:00.000Z"],
  ["2026-07-13T02:35:00.000Z", "2026-07-13T03:15:00.000Z"],
  ["2026-07-13T03:15:00.000Z", "2026-07-13T04:00:00.000Z"],
  ["2026-07-13T10:30:00.000Z", "2026-07-13T11:00:00.000Z"],
]);
```

Add tests that:

- unanchored checkpoints are split sequentially inside the parent block by `minutes`;
- two explicit checkpoints that overlap throw `checkpoint schedule overlaps`;
- a checkpoint on 2026-07-14 is not materialized into 2026-07-13;
- a task without checkpoints keeps its original block with `checkpointIndex: null`.

- [ ] **Step 2: Run the new test and verify RED**

```bash
/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node --test test/checkpoint-scheduler.test.mjs
```

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the pure checkpoint scheduler**

Implement:

```js
export function materializeCheckpointSchedule({ schedule, tasks, date, timezone }) {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const output = [];
  for (const parentBlock of schedule.blocks || []) {
    const task = byId.get(parentBlock.taskId);
    const checkpoints = task?.checkpoints || [];
    if (!checkpoints.length) {
      output.push({ ...parentBlock, checkpointIndex: null });
      continue;
    }
    output.push(...materializeTaskCheckpoints({ parentBlock, checkpoints, date, timezone }));
  }
  assertNoOverlap(output);
  return { ...schedule, blocks: output.sort((a, b) => a.startsAt.localeCompare(b.startsAt)) };
}
```

`materializeTaskCheckpoints()` uses explicit `startsAt/endsAt` when both exist. For unanchored checkpoints, it consumes the task's original block(s) sequentially using `minutes`; if there is insufficient time it leaves the final checkpoint out and adds its task ID to `deferred` rather than inventing an overlap.

- [ ] **Step 4: Wire materialization before persistence**

In `manager.replanDay()`, call the new pure function after `buildDailySchedule()` / `replanRemaining()` and before `ops.replaceSchedule()`:

```js
const checkpointSchedule = materializeCheckpointSchedule({
  schedule: result,
  tasks: activeTasks,
  date: scheduleDate,
  timezone: settings.timezone,
});
const stored = ops.replaceSchedule({ date: scheduleDate, blocks: checkpointSchedule.blocks });
```

Use `checkpointSchedule` for selected IDs and capacity warnings.

- [ ] **Step 5: Verify scheduler and manager tests**

```bash
/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node --test test/checkpoint-scheduler.test.mjs test/manager-service.test.mjs test/schedule-engine.test.mjs
```

Expected: PASS; existing no-overlap and capacity tests remain green.

- [ ] **Step 6: Commit**

```bash
git add src/lib/checkpoint-scheduler.mjs test/checkpoint-scheduler.test.mjs src/lib/manager-service.mjs test/manager-service.test.mjs
git commit -m "feat: schedule timed task checkpoints"
```

---

### Task 4: Build One Executable Daily Brief

**Files:**
- Create: `src/lib/daily-execution-brief.mjs`
- Create: `test/daily-execution-brief.test.mjs`

**Interfaces:**
- Produces: `renderDailyExecutionBrief({ date, schedule, tasks, timezone, feedbackNodes, doNotDo }) -> string`.
- Produces: `renderPlanDelta({ node, facts, changes, currentAction, feedbackDeadline }) -> string`.
- Both functions are pure and perform no database or Feishu access.

- [ ] **Step 1: Write failing brief tests**

Create fixtures for four parent tasks with checkpoint blocks. Assert the 08:00 output contains:

```js
assert.match(text, /【7月13日执行令｜今天只完成4个结果】/);
assert.match(text, /10:00–10:15｜确认三主播排班、货盘和成交口径/);
assert.match(text, /14:00–14:30｜确认线索字段、权限与操作流程/);
assert.match(text, /完成标准：1名员工完成真实线索操作/);
assert.match(text, /12:00–14:00｜午休，不安排任务/);
assert.match(text, /今天不做/);
assert.match(text, /卡住：任务名｜原因/);
assert.doesNotMatch(text, /你直播14小时|你完成直播30单/);
```

Add a multi-block test that asserts one parent title appears once while all checkpoint times appear.

Add a delta test:

```js
assert.equal(renderPlanDelta({
  node: "12:00",
  facts: ["个人IP拍摄提前40分钟完成"],
  changes: ["18:30发布验收提前到11:20–11:50"],
  currentAction: "把3条原片和标题交给剪辑人员",
  feedbackDeadline: "12:00",
}), expectedText);
```

- [ ] **Step 2: Run tests and verify RED**

```bash
/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node --test test/daily-execution-brief.test.mjs
```

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the pure renderer**

Implement these helpers inside the new module:

```js
function localTime(value, timezone) {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).format(new Date(value));
}

function groupBlocksByTask(schedule, tasks) {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const groups = new Map();
  for (const block of [...(schedule?.blocks || [])].sort((a, b) => a.startsAt.localeCompare(b.startsAt))) {
    if (!groups.has(block.taskId)) groups.set(block.taskId, { task: byId.get(block.taskId), blocks: [] });
    groups.get(block.taskId).blocks.push(block);
  }
  return [...groups.values()].filter((group) => group.task);
}

function renderOutcome(group, timezone) {
  const lines = [`${group.task.project}｜${group.task.title}`];
  for (const block of group.blocks) {
    const checkpoint = group.task.checkpoints?.[block.checkpointIndex] || {};
    lines.push(`${localTime(block.startsAt, timezone)}–${localTime(block.endsAt, timezone)}｜${checkpoint.title || group.task.nextAction}`);
    lines.push(`完成标准：${checkpoint.doneDefinition || group.task.doneDefinition}`);
  }
  return lines.join("\n");
}

function feedbackInstructions() {
  return [
    "完成：在飞书点对应子任务。",
    "卡住：回复“卡住：任务名｜原因”。",
    "推迟：回复“推迟：任务名｜原因｜新的完成时间”。",
  ].join("\n");
}
```

The complete brief order is: header, victory conditions, chronological blocks, lunch/buffers, do-not-do list, feedback rules.

- [ ] **Step 4: Verify tests**

```bash
/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node --test test/daily-execution-brief.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/daily-execution-brief.mjs test/daily-execution-brief.test.mjs
git commit -m "feat: render executable daily briefs"
```

---

### Task 5: Sync Detailed Parent Tasks and Timed Children

**Files:**
- Modify: `src/lib/feishu-task-sync.mjs`
- Modify: `test/feishu-task-sync.test.mjs`

**Interfaces:**
- Consumes: detailed task checkpoints and schedule blocks with `checkpointIndex` from Tasks 2–3.
- Produces: one managed parent task per local outcome and one timed child per checkpoint.

- [ ] **Step 1: Write failing sync tests**

Assert parent fields contain project, first action, total estimate and completion standard:

```js
assert.match(api.createdParents[0].description, /项目：个人IP/);
assert.match(api.createdParents[0].description, /第一步：确定3个选题/);
assert.match(api.createdParents[0].description, /完成标准：3条原片可剪辑/);
```

Assert child fields contain their own times and details:

```js
assert.equal(api.createdChildren[0].startAt, "2026-07-13T02:15:00.000Z");
assert.equal(api.createdChildren[0].dueAt, "2026-07-13T02:35:00.000Z");
assert.match(api.createdChildren[0].description, /预计：20分钟/);
assert.match(api.createdChildren[0].description, /完成标准：3个选题和钩子已确认/);
```

Run sync twice and assert parent and child creation counts do not increase.

- [ ] **Step 2: Run focused tests and verify RED**

```bash
/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node --test test/feishu-task-sync.test.mjs
```

Expected: FAIL because child descriptions are empty and checkpoint times are ignored.

- [ ] **Step 3: Implement task and checkpoint field renderers**

Add pure helpers:

```js
function parentDescription(task) {
  return [
    `项目：${task.project}`,
    `第一步：${task.nextAction}`,
    `预计投入：${task.estimateMinutes}分钟`,
    `完成标准：${task.doneDefinition}`,
  ].join("\n");
}

function childDescription(checkpoint) {
  return [
    `预计：${checkpoint.minutes || 15}分钟`,
    `完成标准：${checkpoint.doneDefinition || checkpoint.title}`,
    checkpoint.feedback ? `反馈：${checkpoint.feedback}` : "完成后在飞书勾选本子任务。",
  ].join("\n");
}
```

Build a `(taskId, checkpointIndex) -> block` map and pass each child's `startAt` and `dueAt` from its own block. Parent time is the minimum child start and maximum child end.

- [ ] **Step 4: Verify focused and E2E tests**

```bash
/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node --test test/feishu-task-sync.test.mjs test/checkpoint-e2e.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/feishu-task-sync.mjs test/feishu-task-sync.test.mjs
git commit -m "feat: sync timed Feishu task details"
```

---

### Task 6: Use Full Briefs and Change-Only Checkpoint Messages

**Files:**
- Modify: `src/lib/checkpoint-policy.mjs`
- Modify: `src/lib/checkpoint-runner.mjs`
- Modify: `src/lib/manager-service.mjs`
- Modify: `src/manager-app.mjs`
- Modify: `test/checkpoint-policy.test.mjs`
- Modify: `test/checkpoint-runner.test.mjs`
- Modify: `test/manager-service.test.mjs`
- Modify: `test/checkpoint-e2e.test.mjs`

**Interfaces:**
- Consumes: `renderDailyExecutionBrief()` and `renderPlanDelta()` from Task 4.
- Produces: 08:00 full brief and 09/12/15/18/21 change-only replies.
- Produces: a private sync-failure notice while leaving the checkpoint run failed and retryable.

- [ ] **Step 1: Write failing 08:00 policy contract test**

Create a schedule with detailed blocks and assert:

```js
assert.match(result.reply, /10:15–10:35/);
assert.match(result.reply, /工作内容/);
assert.match(result.reply, /完成标准/);
assert.match(result.reply, /反馈规则/);
```

Delete the old test expectation that only four summary lines are sufficient.

- [ ] **Step 2: Write failing delta-message tests**

Add tests for:

- 09:00 with no messages and no changes: no reply.
- 12:00 early completion: one added high-value action, buffer retained.
- 12:00 delay: reduced scope and new end time.
- 15:00 ordinary new input: current doing task unchanged.
- 18:00: list kept and removed evening work.
- 21:00: one final outcome with absolute deadline.

Every changed response must match `/现在只做：/` and `/反馈截止：/`.

Add a manager test proving `handleAction()` returns the schedule it just created:

```js
const result = await manager.handleAction({ action: "complete_checkpoint", taskId: "task-1", checkpointIndex: 0, deliveryMode: "task_dm", suppressOutbox: true });
assert.ok(Array.isArray(result.schedule.blocks));
```

Add a runner test where `taskSync.pushSchedule()` throws. Assert one private failure row is delivered with:

```text
计划已经生成，但飞书任务同步失败。
当前不要按旧任务执行；系统将在下一节点重试，并在同步完成后发送最新版执行令。
```

and assert the automation run status remains `failed`.

- [ ] **Step 3: Run policy tests and verify RED**

```bash
/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node --test test/checkpoint-policy.test.mjs
```

Expected: FAIL against the current four-line renderer.

- [ ] **Step 4: Replace `renderDispatch()` and wire timezone**

Import Task 4 functions. Change `runDailyDispatch()` to call:

```js
state.replyParts.push(renderDailyExecutionBrief({
  date: state.workDate,
  schedule: state.schedule,
  tasks: deps.tasks.listActive(),
  timezone: deps.timezone || "Asia/Shanghai",
  feedbackNodes: ["12:00", "15:00", "18:00", "21:00", "24:00"],
  doNotDo: ["不新增项目", "不反复修改已经可交付的版本"],
}));
```

Pass `timezone: config.timezone` and `getSchedule: (date) => ({ date, blocks: state.ops.currentSchedule(date) })` when constructing the policy in `manager-app.mjs`.

Change `manager.handleAction()` to retain the result of `replanDay()` and return it as `schedule`. The `complete_checkpoint` branch must also run `replanDay({ reason: "checkpoint_completed", deliveryMode: input.deliveryMode })` before returning. In `applyRemoteProgress()`, set `state.schedule` from the latest returned schedule. Before each replan, call `deps.getSchedule(state.workDate)` and retain it as `previousSchedule`; after replan, compare `(taskId, checkpointIndex, startsAt, endsAt)` tuples to produce explicit moved/added/removed lines for `renderPlanDelta()`.

Replace hard-coded checkpoint replies with `renderPlanDelta()` using:

```js
renderPlanDelta({
  node: state.node,
  facts: actionFacts(state.actions, deps.tasks),
  changes: diffSchedule(previousSchedule, state.schedule, deps.tasks),
  currentAction: nextActionAtOrAfter(state.schedule, deps.tasks, state.node),
  feedbackDeadline: nextFeedbackNode(state.node),
});
```

In `checkpoint-runner.mjs`, wrap only `taskSync.pushSchedule()` in a catch. On error, enqueue the fixed private sync-failure text with idempotency key `private-sync-failure:${workDate}:${node}`, flush it, then rethrow the original error so the run remains retryable.

- [ ] **Step 5: Add an E2E final-text assertion**

In `test/checkpoint-e2e.test.mjs`, run 08:00 and assert the private reply contains the scheduled local times, result, completion standard and feedback format.

Run:

```bash
/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node --test test/checkpoint-policy.test.mjs test/checkpoint-runner.test.mjs test/manager-service.test.mjs test/checkpoint-e2e.test.mjs
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/checkpoint-policy.mjs src/lib/checkpoint-runner.mjs src/lib/manager-service.mjs src/manager-app.mjs test/checkpoint-policy.test.mjs test/checkpoint-runner.test.mjs test/manager-service.test.mjs test/checkpoint-e2e.test.mjs
git commit -m "feat: send executable checkpoint briefs"
```

---

### Task 7: Seed the Approved Personal-Only Week Plan and Model Routing

**Files:**
- Create: `scripts/seed-personal-week.mjs`
- Create: `test/seed-personal-week.test.mjs`
- Modify: `.env.example`
- Modify: `README.md`

**Interfaces:**
- Produces: an idempotent seed command for the 2026-07-13 to 2026-07-17 approved outcomes.
- Produces: stable task IDs and detailed timed checkpoints for personal IP, Jixiang OS, public-live management and private-live preparation.

- [ ] **Step 1: Write a failing idempotent seed test**

Run the seed twice against an in-memory database and assert:

```js
assert.equal(tasks.listActive().filter((task) => task.dueAt === "2026-07-13").length, 4);
assert.equal(tasks.findById("wk20260713-personal-ip").checkpoints.length, 4);
assert.equal(tasks.findById("wk20260713-public-live").estimateMinutes, 60);
assert.equal(tasks.findById("wk20260713-public-live").checkpoints.some((item) => item.title.includes("直播14小时")), false);
assert.equal(new Set(tasks.listAll().map((task) => task.id)).size, tasks.listAll().length);
```

- [ ] **Step 2: Run the test and verify RED**

```bash
/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node --test test/seed-personal-week.test.mjs
```

Expected: FAIL because the seed module does not exist.

- [ ] **Step 3: Implement the seed script**

Export `seedPersonalWeek({ tasks, ops, workDate })` and use stable IDs:

```text
wk20260713-personal-ip
wk20260713-jxos-leads
wk20260713-public-live
wk20260713-private-live
```

Populate the exact titles, checkpoints, times and completion standards from the approved design spec. Existing superseded 7/13 tasks are marked `cancelled` with a `task_superseded_by_clear_plan` event; they are not deleted.

- [ ] **Step 4: Document model routing**

Add to `.env.example` and README:

```text
CODEX_MODEL=gpt-5.6-terra
CODEX_REASONING_EFFORT=high
```

Document that the outer Codex automation remains `gpt-5.6-luna` with `medium` reasoning, while the inner message analyzer uses Terra high. Do not commit the live `.env` value.

- [ ] **Step 5: Verify focused and full tests**

```bash
/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node --test test/seed-personal-week.test.mjs
/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node --test
git diff --check
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add scripts/seed-personal-week.mjs test/seed-personal-week.test.mjs .env.example README.md
git commit -m "feat: seed clear personal execution plans"
```

---

### Task 8: Live Cutover, Duplicate Cleanup, and Acceptance

**Files:**
- Create: `src/lib/personal-plan-cutover.mjs`
- Create: `scripts/cutover-personal-plan.mjs`
- Create: `test/personal-plan-cutover.test.mjs`
- Modify: `src/db/automation-repository.mjs`
- Modify: `test/automation-repository.test.mjs`
- Modify: `src/lib/checkpoint-runner.mjs`
- Modify: `scripts/run-checkpoint.mjs`
- Modify: `test/checkpoint-runner.test.mjs`
- Modify: `src/lib/feishu-tasks.mjs`
- Modify: `test/feishu-tasks.test.mjs`
- Modify: `docs/development-status.md`
- Runtime data only: ignored `.env`, SQLite database, Codex automation, LaunchAgent state, Feishu tasks.

**Interfaces:**
- Consumes: all code from Tasks 1–7.
- Produces: four clear pending Feishu parent tasks for 2026-07-13, correct timed children, one full private brief, and no active legacy writer.

- [ ] **Step 0: Build and test controlled cutover tooling before any live write**

Add an optional validated `replayToken` to `checkpointRunner.run()` and `scripts/run-checkpoint.mjs`. It is allowed only with an explicit forced node, is included in the automation run key and private-summary idempotency key, and never changes the ordinary scheduled run key. The same replay token twice must be a no-op while the original completed `2026-07-13:08:00` audit row remains untouched.

Add a dry-run-by-default cutover tool with two explicit phases:

1. `prepare` reads the migrated local database and paginated Feishu task/subtask state, classifies exact candidates, and writes a mode-0600 manifest under ignored `data/cutover/`. It performs no deletion or link mutation.
2. `apply --manifest=<path>` accepts only a previously prepared manifest, revalidates its work date and candidate signatures, deletes exact manifest GUIDs sequentially, then transactionally rebinds the retained personal-IP parent/child links to `wk20260713-personal-ip` and removes only the confirmed obsolete IP link rows.

The preflight must require:

- exactly five sent legacy-create GUIDs that are unlinked, incomplete, all-day and have zero subtasks;
- exactly one retained personal-IP managed tree with one parent link and three child links;
- exactly one obsolete personal-IP managed tree whose remote parent and exact three children match its four local links;
- exactly five completed historical top-level parents;
- the consolidated target initially has either zero links (not applied) or the exact retained four links (idempotent replay).

Remote parent deletion must not assume child cascading: delete the obsolete managed tree's three exact children before its parent. Treat 404 as success only for a GUID in the private manifest. Never print GUIDs, user/chat identifiers or credentials in the JSON summary.

Test the pure classifier, manifest validation, dry-run zero writes, exact link rebind/removal, partial-delete retry, replay-token run keys, private-summary keys, and identical-token idempotency. Run the full suite and independently review this tooling before Step 1.

- [ ] **Step 1: Pause the Codex automation and identify the exact legacy job**

Use the Codex automation tool to pause automation `n`. Verify:

```bash
launchctl print gui/$(id -u)/com.nge.time-management-master
```

Expected before unload: job is loaded or reports KeepAlive/RunAtLoad even if no PID.

- [ ] **Step 2: Unload the legacy LaunchAgent**

Use the existing uninstall command/runbook for `com.nge.time-management-master`. Verify both commands return no active writer:

```bash
launchctl print gui/$(id -u)/com.nge.time-management-master
ps ax -o command= | rg 'scripts/run-manager.mjs$'
```

Expected: launchctl reports no such service and process search returns no match.

- [ ] **Step 3: Back up the live database**

Call the existing SQLite backup helper and verify the returned file opens read-only and contains the `tasks` table.

- [ ] **Step 4: Apply live model and week seed configuration**

Set ignored local values without printing secrets:

```text
CODEX_MODEL=gpt-5.6-terra
CODEX_REASONING_EFFORT=high
```

Run the idempotent week seed once. Verify 7/13 has exactly four active approved parent outcomes.

- [ ] **Step 5: Re-read and classify remote Feishu tasks**

Construct deletion candidates only when all conditions hold:

```text
GUID is referenced by a sent legacy feishu_task_create outbox row
AND GUID is not present in feishu_task_links
AND top-level task is incomplete
AND task is all-day
AND subtask_count is 0
```

Expected: exactly five candidates. If the count differs, stop without deleting.

- [ ] **Step 6: Delete the five verified duplicates**

Delete by exact GUID through `DELETE /task/v2/tasks/:task_guid`. Re-read the tasklist.

Expected: five historical completed parents remain, no old all-day duplicates remain.

- [ ] **Step 7: Run the 08:00 checkpoint twice**

First run creates/updates the four approved parents and their timed children, then sends one full DM. Second run must be idempotent.

Expected after the second run:

```text
new parents: 0
new children: 0
duplicate parent titles: 0
pending parent outcomes for 7/13: 4
private brief contains every planned time block and feedback rule
```

- [ ] **Step 8: Test early completion and new-input replanning**

Complete the first child in Feishu and add one ordinary DM input. Run the next checkpoint.

Expected: completion syncs once; ordinary input does not interrupt current work; private reply contains only the changed facts, new time and current action.

- [ ] **Step 9: Resume automation and update status**

Resume automation `n`. Update `docs/development-status.md` with exact test counts, live parent/child counts, LaunchAgent state, model routing and remaining risks.

- [ ] **Step 10: Commit documentation**

```bash
git add docs/development-status.md
git commit -m "docs: record personal execution cutover"
```

---

### Task 9: Capture the Completed Work in the WPS Knowledge Base

**Files:**
- Create/update only under `/Users/nge/MAC BOOK的WPS云盘/林恩光的知识库` according to `capture-wps-knowledge`.

**Interfaces:**
- Consumes: approved design, implementation plan, actual commits, test results and live acceptance evidence.
- Produces: one company-level reusable method note, one project-level implementation record, updated indexes and a dated整理报告.

- [ ] **Step 1: Read the required knowledge rules in full**

Read:

```text
90_Codex_知识整理规则/00_总规则.md
90_Codex_知识整理规则/01_分类规则.md
02_JXOS_极享公司OS/10_知识库/00_知识库架构与维护规则.md
```

- [ ] **Step 2: Inspect existing same-topic entries**

Inspect the FounderOS time-management index, current project development note, Codex-Feishu company capability entry and latest整理报告. Do not create duplicate entry points.

- [ ] **Step 3: Write two evidence-based documents**

Company-level note: reusable “result task + timed child + execution DM + fixed checkpoint replan” method.  
Project-level note: commits, migrations, test counts, live cleanup, model routing, current state and remaining risks.

Use `试运行` unless a week of real execution has been reviewed. Do not write planned work as completed.

- [ ] **Step 4: Update indexes and整理报告**

Create a date-named report in `02_JXOS_极享公司OS/10_知识库/`, then update `本次整理报告.md` to point only to the newest report while retaining historical reports.

- [ ] **Step 5: Verify the capture**

Verify files and links with `test -f` and `rg`; scan for app secrets, `open_id`, `chat_id`, task GUIDs and unexplained placeholders. The knowledge base is not assumed to be a Git repository, so do not invent a commit.
