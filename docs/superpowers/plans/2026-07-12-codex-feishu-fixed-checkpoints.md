# Codex Fixed Checkpoints and Feishu Tasks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Terminal-resident Feishu WebSocket manager with one-shot Codex automations that poll the owner's direct bot conversation at fixed checkpoints, reconcile real Feishu parent tasks and subtasks, adjust the schedule, and send only necessary merged direct messages.

**Architecture:** Keep Markdown projects as the project source of truth and SQLite as the runtime source of truth. Add a polling/runtime repository, a direct-message reader, a parent/subtask synchronizer, and a pure checkpoint policy layer; coordinate them through a one-shot runner invoked by Codex automation. Reuse the current schedule engine, acceptance service, project writeback, outbox retry, and daily-review modules.

**Tech Stack:** Node.js 24 ESM, `node:test`, built-in `node:sqlite`, Feishu OpenAPI Task v2 and IM v1, Codex CLI structured outputs, Markdown/WPS knowledge base, Codex local automations.

## Global Constraints

- Use Asia/Shanghai and fixed nodes at 08:00, 09:00, 12:00, 15:00, 18:00, 21:00, and 24:00.
- Interpret 24:00 as 00:00 on the following calendar day while assigning the review to the previous work date.
- Use Feishu tasks for execution state and real Feishu subtasks for 15–45 minute actions.
- Use only the configured owner's one-to-one bot conversation as the inbound source.
- Merge all messages between successful checkpoints into one analysis and at most one direct-message summary.
- Stay silent when there is no new input, progress anomaly, or material schedule change. The 08:00 and 24:00 nodes always send summaries.
- Keep daily critical tasks at five or fewer, capacity at 70%, 12:00–14:00 unavailable, and each main task at 120 minutes or fewer.
- Personal IP remains the default priority; only an unusable Jixiang OS bug or explicit business loss may override it.
- Never let free-form chat bypass project evidence acceptance or write subjective progress percentages.
- Do not require a resident Terminal process or Feishu WebSocket after cutover.
- Preserve existing `.env`, SQLite data, project Markdown, weekly plans, acceptance records, and outbox retry behavior.
- Do not add cloud services, calendar integration, group-chat ingestion, multi-user delegation, or high-risk external actions.

## File and Module Map

### New files

- `src/db/automation-repository.mjs` — message ledger, run claims, lock, and Feishu task links.
- `src/lib/feishu-polling.mjs` — paginated direct-message polling and normalization.
- `src/lib/feishu-task-sync.mjs` — parent/subtask reconciliation in both directions.
- `src/lib/codex-checkpoint-schema.json` — structured batch classification schema.
- `src/lib/checkpoint-schedule.mjs` — fixed-node and missed-node resolution.
- `src/lib/checkpoint-policy.mjs` — node-specific decisions and merged replies.
- `src/lib/checkpoint-runner.mjs` — failure-safe one-shot orchestration.
- `scripts/run-checkpoint.mjs` — automation entry point.
- Matching tests: `test/automation-repository.test.mjs`, `test/feishu-polling.test.mjs`, `test/feishu-task-sync.test.mjs`, `test/checkpoint-schedule.test.mjs`, `test/checkpoint-policy.test.mjs`, `test/checkpoint-runner.test.mjs`, and `test/checkpoint-e2e.test.mjs`.

### Modified files

- `src/db/database.mjs`, `src/config.mjs`, `src/lib/feishu-messages.mjs`, `src/lib/feishu-tasks.mjs`, `src/lib/codex-analyzer.mjs`, `src/lib/manager-service.mjs`, `src/manager-app.mjs`, `src/lib/daily-review.mjs`, `src/lib/outbox-worker.mjs`, `package.json`, `.env.example`, `README.md`, and `docs/development-status.md`.

---

### Task 1: Persist Polling State, Run Claims, Locks, and Feishu Links

**Files:**
- Create: `src/db/automation-repository.mjs`
- Modify: `src/db/database.mjs`
- Test: `test/automation-repository.test.mjs`
- Test: `test/database.test.mjs`

**Interfaces:**
- Produces: `createAutomationRepository(db, deps)`.
- Produces: `claimLock({ owner, expiresAt })`, `releaseLock(owner)`.
- Produces: `claimRun({ runKey, workDate, node, expiresAt })`, `completeRun(runKey, summary)`, `failRun(runKey, error)`.
- Produces: `recordInbound(messages)`, `listPendingInbound(chatId)`.
- Produces: `getMessageCursor(chatId)`, `finalizeInbound({ messageIds, runKey, claimToken, chatId, polledThrough })`.
- `finalizeInbound` is the only public write path for processed messages and message cursors; it must verify the current run claim token and commit both changes atomically.
- Produces: `upsertFeishuLink(link)`, `findFeishuLink(localTaskId, checkpointIndex)`, `listFeishuLinks(localTaskId)`.

- [ ] **Step 1: Write failing repository tests**

```js
test("claims one global runner until the lease expires", () => {
  const clock = { value: "2026-07-13T00:00:00.000Z" };
  const repo = createAutomationRepository(db, { now: () => clock.value });
  assert.equal(repo.claimLock({ owner: "run-a", expiresAt: "2026-07-13T00:05:00.000Z" }), true);
  assert.equal(repo.claimLock({ owner: "run-b", expiresAt: "2026-07-13T00:05:00.000Z" }), false);
  clock.value = "2026-07-13T00:06:00.000Z";
  assert.equal(repo.claimLock({ owner: "run-b", expiresAt: "2026-07-13T00:11:00.000Z" }), true);
});

test("does not process one inbound message twice", () => {
  const repo = createAutomationRepository(db, { now: () => "2026-07-13T01:00:00.000Z" });
  const message = { messageId: "om-1", chatId: "oc-p2p", senderId: "ou-owner", messageType: "text", content: { text: "新增选题" }, createdAt: "2026-07-13T00:30:00.000Z" };
  repo.recordInbound([message, message]);
  assert.deepEqual(repo.listPendingInbound("oc-p2p").map((item) => item.messageId), ["om-1"]);
  repo.claimRun({ runKey: "2026-07-13:09:00", workDate: "2026-07-13", node: "09:00", expiresAt: "2026-07-13T01:05:00.000Z" });
  const claim = repo.claimRun({ runKey: "2026-07-13:09:00", workDate: "2026-07-13", node: "09:00", expiresAt: "2026-07-13T01:05:00.000Z" });
  repo.finalizeInbound({ messageIds: ["om-1"], runKey: "2026-07-13:09:00", claimToken: claim.run.claimToken, chatId: "oc-p2p", polledThrough: "2026-07-13T01:00:00.000Z" });
  assert.deepEqual(repo.listPendingInbound("oc-p2p"), []);
});

test("maps parent and checkpoint GUIDs independently", () => {
  const repo = createAutomationRepository(db);
  repo.upsertFeishuLink({ localTaskId: "task-1", checkpointIndex: -1, taskGuid: "parent-1", parentGuid: null, snapshotHash: "a" });
  repo.upsertFeishuLink({ localTaskId: "task-1", checkpointIndex: 0, taskGuid: "child-1", parentGuid: "parent-1", snapshotHash: "b" });
  assert.equal(repo.findFeishuLink("task-1", -1).taskGuid, "parent-1");
  assert.equal(repo.findFeishuLink("task-1", 0).parentGuid, "parent-1");
});

test("finalizes messages and cursor under the current run claim", () => {
  const repo = createAutomationRepository(db, { now: () => "2026-07-13T01:00:00.000Z" });
  const claim = repo.claimRun({ runKey: "2026-07-13:09:00", workDate: "2026-07-13", node: "09:00", expiresAt: "2026-07-13T01:05:00.000Z" });
  assert.equal(repo.getMessageCursor("oc-p2p"), null);
  repo.finalizeInbound({ messageIds: [], runKey: "2026-07-13:09:00", claimToken: claim.run.claimToken, chatId: "oc-p2p", polledThrough: "2026-07-13T01:00:00.000Z" });
  assert.equal(repo.getMessageCursor("oc-p2p").polledThrough, "2026-07-13T01:00:00.000Z");
});
```

- [ ] **Step 2: Run tests and verify RED**

```bash
/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node --test test/automation-repository.test.mjs test/database.test.mjs
```

Expected: FAIL because migration 4 and `createAutomationRepository` are missing.

- [ ] **Step 3: Add migration 4**

```js
const MIGRATION_4 = `
CREATE TABLE automation_runs (
  run_key TEXT PRIMARY KEY, work_date TEXT NOT NULL, node TEXT NOT NULL,
  status TEXT NOT NULL, started_at TEXT NOT NULL, expires_at TEXT NOT NULL,
  completed_at TEXT, error TEXT, summary_json TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE automation_locks (
  lock_name TEXT PRIMARY KEY, owner TEXT NOT NULL, expires_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE inbound_messages (
  message_id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, sender_id TEXT NOT NULL,
  message_type TEXT NOT NULL, content_json TEXT NOT NULL, created_at TEXT NOT NULL,
  processed_run_key TEXT, recorded_at TEXT NOT NULL,
  FOREIGN KEY(processed_run_key) REFERENCES automation_runs(run_key)
);
CREATE TABLE message_cursors (
  chat_id TEXT PRIMARY KEY, polled_through TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE feishu_task_links (
  local_task_id TEXT NOT NULL, checkpoint_index INTEGER NOT NULL,
  task_guid TEXT NOT NULL UNIQUE, parent_guid TEXT, snapshot_hash TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL, PRIMARY KEY(local_task_id, checkpoint_index),
  FOREIGN KEY(local_task_id) REFERENCES tasks(id)
);
CREATE INDEX idx_inbound_pending ON inbound_messages(chat_id, processed_run_key, created_at);
CREATE INDEX idx_feishu_parent ON feishu_task_links(parent_guid);
`;
```

Append `MIGRATION_4` to the migrations array.

- [ ] **Step 4: Implement transactional repository methods**

Use `withTransaction` for claims, message commit, and cursor advancement. Replace a lock only when `expires_at <= now()`. A completed run returns `{ claimed: false }`; a failed or expired run may resume. Advance `message_cursors.polled_through` only in the same successful commit that marks the polled messages processed. Sanitize stored errors to 500 characters. Map snake-case rows to the camel-case interfaces above.

- [ ] **Step 5: Verify and commit**

```bash
/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node --test test/automation-repository.test.mjs test/database.test.mjs
/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node --test
git diff --check
git add src/db/database.mjs src/db/automation-repository.mjs test/automation-repository.test.mjs test/database.test.mjs
git commit -m "feat: persist fixed-checkpoint runtime state"
```

---

### Task 2: Poll and Normalize the Owner's Direct Bot Conversation

**Files:**
- Create: `src/lib/feishu-polling.mjs`
- Modify: `src/config.mjs`
- Modify: `src/lib/feishu-messages.mjs`
- Test: `test/feishu-polling.test.mjs`
- Test: `test/config.test.mjs`
- Test: `test/feishu-delivery.test.mjs`

**Interfaces:**
- Produces: `listConversationMessages(config, { chatId, startTime, endTime }, deps)`.
- Produces: `normalizePolledMessage(item)`.
- Produces: `resolveDirectChatId(config, ops, deps)`.
- Modifies: `sendFeishuMessage` result to `{ externalId, chatId }`.

- [ ] **Step 1: Write failing polling tests**

```js
test("reads every history page and keeps only owner messages", async () => {
  const paths = [];
  const request = async (_config, path) => {
    paths.push(path);
    if (!path.includes("page_token=")) return { data: { has_more: true, page_token: "next", items: [rawMessage("om-1", "ou-owner", "user", "第一条", "1000")] } };
    return { data: { has_more: false, items: [rawMessage("om-2", "cli-bot", "app", "机器人回复", "2000"), rawMessage("om-3", "ou-owner", "user", "第二条", "3000")] } };
  };
  const messages = await listConversationMessages({ managerUserId: "ou-owner" }, { chatId: "oc-p2p", startTime: "1", endTime: "4" }, { request });
  assert.deepEqual(messages.map((item) => item.messageId), ["om-1", "om-3"]);
  assert.equal(paths.length, 2);
});

test("does not guess image contents", () => {
  const image = normalizePolledMessage({ ...rawMessage("om-2", "ou-owner", "user", "{}", "2000"), msg_type: "image", body: { content: "{\"image_key\":\"img-1\"}" } });
  assert.deepEqual(image.content, { imageKey: "img-1", unavailableForTextAnalysis: true });
});

test("captures the p2p chat id returned by a bootstrap DM", async () => {
  const values = new Map();
  const chatId = await resolveDirectChatId(
    { feishuReceiveId: "ou-owner", feishuReceiveIdType: "open_id" },
    { getSetting: (key) => values.get(key), setSetting: (key, value) => values.set(key, value) },
    { send: async () => ({ externalId: "om-bootstrap", chatId: "oc-p2p" }) },
  );
  assert.equal(chatId, "oc-p2p");
  assert.equal(values.get("feishu_p2p_chat_id"), "oc-p2p");
});
```

- [ ] **Step 2: Run tests and verify RED**

```bash
/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node --test test/feishu-polling.test.mjs test/config.test.mjs test/feishu-delivery.test.mjs
```

- [ ] **Step 3: Add configuration and return chat IDs from sends**

```js
feishuP2pChatId: merged.FEISHU_P2P_CHAT_ID || "",
```

```js
return {
  externalId: response?.data?.message_id || "",
  chatId: response?.data?.chat_id || "",
};
```

- [ ] **Step 4: Implement paginated history reads**

```js
const params = new URLSearchParams({
  container_id_type: "chat",
  container_id: chatId,
  sort_type: "ByCreateTimeAsc",
  page_size: "50",
});
if (startTime) params.set("start_time", String(startTime));
if (endTime) params.set("end_time", String(endTime));
if (pageToken) params.set("page_token", pageToken);
const response = await request(config, `/im/v1/messages?${params}`);
```

Continue while `data.has_more === true`, even when items are empty. Keep only user messages from `config.managerUserId`. Resolve chat ID from config, persisted setting, then a bootstrap DM; throw if the returned `chat_id` is absent.

- [ ] **Step 5: Verify and commit**

```bash
/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node --test test/feishu-polling.test.mjs test/config.test.mjs test/feishu-delivery.test.mjs
/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node --test
git diff --check
git add src/config.mjs src/lib/feishu-messages.mjs src/lib/feishu-polling.mjs test/feishu-polling.test.mjs test/config.test.mjs test/feishu-delivery.test.mjs
git commit -m "feat: poll owner direct messages from Feishu"
```

---

### Task 3: Reconcile Real Feishu Parent Tasks and Subtasks

**Files:**
- Create: `src/lib/feishu-task-sync.mjs`
- Modify: `src/lib/feishu-tasks.mjs`
- Modify: `src/lib/feishu-messages.mjs`
- Test: `test/feishu-task-sync.test.mjs`
- Test: `test/feishu-tasks.test.mjs`

**Interfaces:**
- Produces: `listTasklistTasks(config, options, deps)` and `listSubtasks(config, parentGuid, deps)`.
- Produces: exported `buildTaskBody(config, task, options)` with `startAt`, `dueAt`, and `includeTasklist`.
- Produces: `createFeishuTaskSynchronizer({ config, tasks, links, api, clock })`.
- Produces: `pushSchedule({ date, schedule })` and `pullProgress({ date })`.

- [ ] **Step 1: Write failing task/subtask tests**

```js
test("creates timed parents in the tasklist and children outside it", () => {
  const config = { feishuTasklistGuid: "list-1", feishuTaskAssigneeId: "ou-owner" };
  const parent = buildTaskBody(config, { summary: "拍摄视频", startAt: "2026-07-13T02:00:00.000Z", dueAt: "2026-07-13T04:00:00.000Z" });
  const child = buildTaskBody(config, { summary: "写脚本", dueAt: "2026-07-13T02:30:00.000Z" }, { includeTasklist: false });
  assert.equal(parent.start.is_all_day, false);
  assert.deepEqual(parent.tasklists, [{ tasklist_guid: "list-1" }]);
  assert.equal("tasklists" in child, false);
});

test("creates one child per local checkpoint exactly once", async () => {
  const fixture = syncFixture({ checkpoints: [{ title: "写脚本", completed: false }, { title: "拍摄", completed: false }] });
  await fixture.sync.pushSchedule({ date: "2026-07-13", schedule: fixture.schedule });
  await fixture.sync.pushSchedule({ date: "2026-07-13", schedule: fixture.schedule });
  assert.deepEqual(fixture.api.createdParents.map((item) => item.summary), ["完成口播视频"]);
  assert.deepEqual(fixture.api.createdChildren.map((item) => item.summary), ["写脚本", "拍摄"]);
});

test("pulls one child completion without completing its parent", async () => {
  const fixture = syncFixture({ checkpoints: [{ title: "写脚本", completed: false }, { title: "拍摄", completed: false }] });
  fixture.api.remoteChildren = [{ guid: "child-0", completed_at: "1783908000000" }, { guid: "child-1", completed_at: "0" }];
  const result = await fixture.sync.pullProgress({ date: "2026-07-13" });
  assert.deepEqual(result.completedCheckpoints, [{ localTaskId: "task-1", checkpointIndex: 0, completedAt: "2026-07-13T02:00:00.000Z" }]);
  assert.deepEqual(result.completedTasks, []);
});
```

- [ ] **Step 2: Run tests and verify RED**

```bash
/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node --test test/feishu-tasks.test.mjs test/feishu-task-sync.test.mjs
```

- [ ] **Step 3: Extend Task v2 wrappers**

```js
if (task.startAt) body.start = { timestamp: String(new Date(task.startAt).getTime()), is_all_day: false };
if (task.dueAt) body.due = { timestamp: String(new Date(task.dueAt).getTime()), is_all_day: false };
if (options.includeTasklist !== false && config.feishuTasklistGuid) {
  body.tasklists = [{ tasklist_guid: config.feishuTasklistGuid }];
}
```

Implement pagination at:

```text
GET /task/v2/tasklists/:tasklist_guid/tasks?page_size=100&user_id_type=open_id
GET /task/v2/tasks/:task_guid/subtasks?page_size=100&user_id_type=open_id
```

Follow `data.has_more`, not item count.

- [ ] **Step 4: Implement stable synchronization**

For each scheduled task, use checkpoint index `-1` for the parent and `0..n` for children. Create only when a link is absent. Update only when a SHA-256 hash of managed fields changes. Never delete remotely edited tasks. `pullProgress` returns remote changes but does not mutate local status; the runner routes child completion through `tasks.completeCheckpoint` and parent completion through `manager.handleAction({ action: "complete" })`.

- [ ] **Step 5: Verify and commit**

```bash
/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node --test test/feishu-tasks.test.mjs test/feishu-task-sync.test.mjs
/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node --test
git diff --check
git add src/lib/feishu-tasks.mjs src/lib/feishu-messages.mjs src/lib/feishu-task-sync.mjs test/feishu-tasks.test.mjs test/feishu-task-sync.test.mjs
git commit -m "feat: synchronize Feishu parent tasks and subtasks"
```

---

### Task 4: Analyze One Message Batch Conservatively

**Files:**
- Create: `src/lib/codex-checkpoint-schema.json`
- Modify: `src/lib/codex-analyzer.mjs`
- Test: `test/codex-analyzer.test.mjs`

**Interfaces:**
- Produces: `analyzer.analyzeCheckpointMessages({ node, workDate, messages, context })`.
- Returns: `{ items, combinedReplyContext, analysisStatus, analysisError? }`.
- Each item has `messageIds`, `category`, `disposition`, `title`, `projectId`, `urgency`, `mustBeOwner`, `estimateMinutes`, `dueAt`, `nextAction`, `doneDefinition`, `checkpoints`, and `rationale`.

- [ ] **Step 1: Write failing analyzer tests**

```js
test("analyzes one interval as one batch", async () => {
  const analyzer = createCodexAnalyzer({}, { run: async () => JSON.stringify({
    items: [{
      messageIds: ["om-1", "om-2"], category: "idea", disposition: "candidate_pool",
      title: "老板为什么要学Codex", projectId: "personal-ip", urgency: "low",
      mustBeOwner: true, estimateMinutes: 40, dueAt: null,
      nextAction: "写出一个真实成本案例", doneDefinition: "形成60秒脚本第一版",
      checkpoints: ["确定真实案例", "写出开头钩子", "完成脚本第一版"],
      rationale: "符合个人IP获客方向，但不应打断当前拍摄",
    }],
    combinedReplyContext: "一条有效选题进入候选池",
  }) });
  const result = await analyzer.analyzeCheckpointMessages({ node: "09:00", workDate: "2026-07-13", messages: [{ messageId: "om-1" }, { messageId: "om-2" }], context: {} });
  assert.equal(result.analysisStatus, "complete");
  assert.equal(result.items[0].disposition, "candidate_pool");
});

test("invalid AI output falls back to candidate review", async () => {
  const analyzer = createCodexAnalyzer({}, { run: async () => "{}" });
  const result = await analyzer.analyzeCheckpointMessages({ node: "15:00", workDate: "2026-07-13", messages: [{ messageId: "om-9", content: { text: "想到一个功能" } }], context: {} });
  assert.equal(result.analysisStatus, "failed");
  assert.equal(result.items[0].disposition, "candidate_pool");
});
```

- [ ] **Step 2: Run tests and verify RED**

```bash
/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node --test test/codex-analyzer.test.mjs
```

- [ ] **Step 3: Add the strict schema**

Use category enum `task`, `idea`, `system_bug`, `meeting`, `blocker`, `defer_reason`, `evidence`, `communication`; disposition enum `interrupt_now`, `schedule_today`, `candidate_pool`, `do_not_schedule`, `task_feedback`, `evidence_submission`, `no_action`; urgency enum `high`, `medium`, `low`. Require every field, allow nullable `dueAt`/`projectId`, limit checkpoints to 1–8 strings, and set `additionalProperties: false`.

- [ ] **Step 4: Implement prompt, validation, and fallback**

The prompt must say:

```text
Classify one fixed-checkpoint batch. Do not execute actions or claim scheduling.
Interrupt only for an unusable Jixiang OS bug, explicit current business loss,
a real owner-only deadline, or a blocker affecting multiple people.
Personal IP is otherwise default priority. Ideas without deadlines enter candidate_pool.
Never invent deadlines, losses, customers, owners, evidence, or attachment contents.
Each executable task needs 1-8 concrete 15-45 minute checkpoints.
```

On failure, emit one conservative candidate item per message. Never default to interrupt or schedule-today.

- [ ] **Step 5: Verify and commit**

```bash
/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node --test test/codex-analyzer.test.mjs
/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node --test
git diff --check
git add src/lib/codex-analyzer.mjs src/lib/codex-checkpoint-schema.json test/codex-analyzer.test.mjs
git commit -m "feat: classify fixed-checkpoint message batches"
```

---

### Task 5: Resolve Due Nodes and Apply Node-Specific Policies

**Files:**
- Create: `src/lib/checkpoint-schedule.mjs`
- Create: `src/lib/checkpoint-policy.mjs`
- Modify: `src/lib/manager-service.mjs`
- Test: `test/checkpoint-schedule.test.mjs`
- Test: `test/checkpoint-policy.test.mjs`
- Test: `test/manager-service.test.mjs`

**Interfaces:**
- Produces: `resolveCheckpointContext({ now, timezone })`.
- Produces: `dueCheckpointNodes({ now, timezone, completedNodes })`.
- Produces: `createCheckpointPolicy(deps).apply({ node, workDate, messages, analysis, remoteProgress })`.
- Adds: `manager.replanDay({ deliveryMode: "task_dm" })`, which does not enqueue task cards.

- [ ] **Step 1: Write failing schedule tests**

```js
test("maps midnight to the previous work date review", () => {
  assert.deepEqual(resolveCheckpointContext({ now: "2026-07-14T00:00:00+08:00", timezone: "Asia/Shanghai" }), {
    workDate: "2026-07-13", currentNode: "24:00",
  });
});

test("runs missed 08:00 before 09:00", () => {
  assert.deepEqual(dueCheckpointNodes({ now: "2026-07-13T09:00:00+08:00", timezone: "Asia/Shanghai", completedNodes: [] }).nodes, ["08:00", "09:00"]);
});

test("collapses expired progress checks at 18:00", () => {
  assert.deepEqual(dueCheckpointNodes({ now: "2026-07-13T18:00:00+08:00", timezone: "Asia/Shanghai", completedNodes: ["08:00"] }).nodes, ["18:00"]);
});
```

- [ ] **Step 2: Write failing policy tests**

```js
test("09:00 stays silent without messages or changes", async () => {
  const result = await policyFixture().apply({ node: "09:00", workDate: "2026-07-13", messages: [], analysis: { items: [] }, remoteProgress: emptyProgress });
  assert.equal(result.replyRequired, false);
  assert.equal(result.changed, false);
});

test("12:00 turns zero progress into one 15-minute action", async () => {
  const result = await policyFixture({ scheduledTask: task({ checkpoints: [{ title: "写脚本", completed: false }] }) })
    .apply({ node: "12:00", workDate: "2026-07-13", messages: [], analysis: { items: [] }, remoteProgress: emptyProgress });
  assert.match(result.reply, /15分钟/);
  assert.match(result.reply, /写脚本/);
});

test("candidate ideas never interrupt a doing task", async () => {
  const result = await policyFixture({ doingTask: task({ status: "doing" }) })
    .apply({ node: "15:00", workDate: "2026-07-13", messages: [{ messageId: "om-1" }], analysis: { items: [{ messageIds: ["om-1"], disposition: "candidate_pool", title: "新选题" }] }, remoteProgress: emptyProgress });
  assert.equal(result.actions.some((item) => item.type === "interrupt_current"), false);
});

test("21:00 keeps one core task through midnight", async () => {
  const result = await policyFixture({ remainingTasks: [task({ id: "a" }), task({ id: "b" }) })
    .apply({ node: "21:00", workDate: "2026-07-13", messages: [], analysis: { items: [] }, remoteProgress: emptyProgress });
  assert.equal(result.schedule.blocks.length, 1);
});
```

- [ ] **Step 3: Run tests and verify RED**

```bash
/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node --test test/checkpoint-schedule.test.mjs test/checkpoint-policy.test.mjs test/manager-service.test.mjs
```

- [ ] **Step 4: Implement fixed-node resolution**

```js
export const CHECKPOINT_NODES = ["08:00", "09:00", "12:00", "15:00", "18:00", "21:00", "24:00"];
```

At local 00:00 map to previous date 24:00. From 08:00 onward choose the greatest node not after local time. Only missed 08:00 and previous-day 24:00 are prerequisites; collapse other missed checks into the current node.

- [ ] **Step 5: Implement one handler map**

```js
const handlers = {
  "08:00": runDailyDispatch,
  "09:00": runMorningCalibration,
  "12:00": runMorningProgress,
  "15:00": runAfternoonStartCheck,
  "18:00": runDayOutcomeCheck,
  "21:00": runFinalSprint,
  "24:00": runDailyReview,
};
```

Shared behavior applies deterministic feedback/evidence first; creates scheduled tasks only for `interrupt_now` and `schedule_today`; keeps candidate tasks outside today's schedule; preserves a doing task except allowed P0; uses the current 70% schedule engine; asks for the first incomplete checkpoint after zero progress; keeps at most one core evening task at 18:00/21:00; and renders one merged reply.

- [ ] **Step 6: Add polling delivery mode**

```js
if (options.deliveryMode !== "task_dm") {
  ops.enqueueOutbox({
    kind: isDailyPlan ? "daily_plan_card" : "replan_card",
    payload: { card, changed: reason, reason },
    idempotencyKey,
  });
}
```

Keep schedule events/reminders. Route remote parent completion through `handleAction({ action: "complete", taskId, idempotencyKey })` so evidence acceptance remains intact.

- [ ] **Step 7: Verify and commit**

```bash
/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node --test test/checkpoint-schedule.test.mjs test/checkpoint-policy.test.mjs test/manager-service.test.mjs
/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node --test
git diff --check
git add src/lib/checkpoint-schedule.mjs src/lib/checkpoint-policy.mjs src/lib/manager-service.mjs test/checkpoint-schedule.test.mjs test/checkpoint-policy.test.mjs test/manager-service.test.mjs
git commit -m "feat: apply fixed checkpoint execution policies"
```

---

### Task 6: Build the One-Shot Runner and Merged Direct Replies

**Files:**
- Create: `src/lib/checkpoint-runner.mjs`
- Create: `scripts/run-checkpoint.mjs`
- Modify: `src/manager-app.mjs`
- Modify: `src/lib/feishu-messages.mjs`
- Modify: `src/lib/outbox-worker.mjs`
- Modify: `package.json`
- Test: `test/checkpoint-runner.test.mjs`
- Test: `test/outbox-worker.test.mjs`

**Interfaces:**
- Produces: `createCheckpointRunner(deps).run({ now?, forcedNode?, dryRun? })`.
- Summary: `{ status, workDate, nodes, messagesRead, messagesProcessed, tasksCreated, tasksUpdated, repliesQueued, reviewCreated, errors }`.
- CLI: `node scripts/run-checkpoint.mjs [--node=08:00] [--now=<ISO>] [--dry-run]`.

- [ ] **Step 1: Write failing runner tests**

```js
test("commits messages only after sync and reply queueing succeed", async () => {
  const fixture = runnerFixture({ messages: [message("om-1", "新增一个选题")] });
  const result = await fixture.runner.run({ now: "2026-07-13T09:00:00+08:00" });
  assert.equal(result.status, "completed");
  assert.deepEqual(fixture.runtime.listPendingInbound("oc-p2p"), []);
  assert.equal(fixture.outbox.filter((item) => item.kind === "private_checkpoint_summary").length, 1);
});

test("leaves messages pending when task sync fails", async () => {
  const fixture = runnerFixture({ messages: [message("om-1", "今天要修客户模块")], syncError: new Error("task api unavailable") });
  await assert.rejects(() => fixture.runner.run({ now: "2026-07-13T09:00:00+08:00" }), /task api unavailable/);
  assert.deepEqual(fixture.runtime.listPendingInbound("oc-p2p").map((item) => item.messageId), ["om-1"]);
});

test("queues no reply for a quiet healthy 15:00 run", async () => {
  const result = await runnerFixture({ messages: [], healthyProgress: true }).runner.run({ now: "2026-07-13T15:00:00+08:00" });
  assert.equal(result.repliesQueued, 0);
});

test("an overlapping runner performs no writes", async () => {
  const result = await runnerFixture({ lockHeld: true }).runner.run({ now: "2026-07-13T18:00:00+08:00" });
  assert.deepEqual(result, { status: "skipped", reason: "lock_held" });
});
```

- [ ] **Step 2: Run tests and verify RED**

```bash
/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node --test test/checkpoint-runner.test.mjs test/outbox-worker.test.mjs
```

- [ ] **Step 3: Implement the mandatory orchestration order**

```text
claim global lock
resolve direct chat id and due nodes
claim each run
read the chat cursor, poll through the current run time, and record messages
pull remote task/subtask progress
apply remote progress through manager actions
analyze the pending batch once
apply node policy
push parent tasks and subtasks
enqueue at most one private summary
flush outbox
atomically finalize messages and the chat cursor with the current run claim token
complete run
release lock
```

On exception: fail the run, keep inbound pending, release in `finally`, sanitize logs, and rethrow.

- [ ] **Step 4: Add private summary delivery**

Send `private_checkpoint_summary` as plain text to the configured owner `open_id`, never a card or group chat. Use:

```js
const idempotencyKey = `private-summary:${workDate}:${node}:${scheduleVersion}:${messageDigest}`;
```

- [ ] **Step 5: Add one-shot runtime and CLI**

Expose `createManagerRuntime(config)` without WebSocket, intervals, or resident reminders. Parse only the three documented flags. Print exactly one JSON line. Add:

```json
"checkpoint": "node scripts/run-checkpoint.mjs"
```

- [ ] **Step 6: Verify and commit**

```bash
/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node --test test/checkpoint-runner.test.mjs test/outbox-worker.test.mjs
/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node --test
git diff --check
git add src/lib/checkpoint-runner.mjs scripts/run-checkpoint.mjs src/manager-app.mjs src/lib/feishu-messages.mjs src/lib/outbox-worker.mjs package.json test/checkpoint-runner.test.mjs test/outbox-worker.test.mjs
git commit -m "feat: run time manager as one-shot checkpoints"
```

---

### Task 7: Prove the Full Direct-Message to Review Loop

**Files:**
- Create: `test/checkpoint-e2e.test.mjs`
- Modify: `src/lib/daily-review.mjs`
- Modify: `test/daily-review.test.mjs`
- Modify: `docs/development-status.md`

**Interfaces:**
- Consumes: public runner with fake Feishu/Codex boundaries.
- Proves: merged polling, task/subtask creation, idempotency, remote progress, acceptance routing, and daily review.

- [ ] **Step 1: Write the end-to-end test**

```js
test("one day flows from merged DMs through subtasks and review", async () => {
  const day = e2eFixture();
  day.feishu.addDirectMessages([
    message("om-1", "想到一个选题：老板为什么要学Codex", "2026-07-13T00:10:00.000Z"),
    message("om-2", "用我们买CRM花一万元的经历", "2026-07-13T00:20:00.000Z"),
  ]);
  await day.runner.run({ now: "2026-07-13T09:00:00+08:00" });
  assert.equal(day.feishu.privateReplies.length, 1);
  assert.equal(day.feishu.parentTasks.length, 0);

  day.seedConfirmedDailyTask();
  await day.runner.run({ now: "2026-07-13T12:00:00+08:00" });
  assert.equal(day.feishu.parentTasks.length, 1);
  assert.equal(day.feishu.subtasks.length, 3);

  day.feishu.completeSubtask(0, "2026-07-13T04:30:00.000Z");
  await day.runner.run({ now: "2026-07-13T15:00:00+08:00" });
  assert.equal(day.tasks.findById("task-video").checkpoints[0].completed, true);

  await day.runner.run({ now: "2026-07-13T15:00:00+08:00" });
  assert.equal(day.events.filter((event) => event.kind === "checkpoint_completed").length, 1);

  day.feishu.completeParent("2026-07-13T13:00:00.000Z");
  await day.runner.run({ now: "2026-07-13T21:00:00+08:00" });
  assert.equal(day.tasks.findById("task-video").status, "pending_acceptance");

  await day.runner.run({ now: "2026-07-14T00:00:00+08:00" });
  assert.match(day.ops.getReview("2026-07-13").renderedText, /今日复盘/);
});
```

- [ ] **Step 2: Run and verify RED**

```bash
/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node --test test/checkpoint-e2e.test.mjs test/daily-review.test.mjs
```

- [ ] **Step 3: Include main/subtask counts in review**

```js
summary.taskProgress = {
  mainCompleted: tasks.filter((task) => task.status === "done").length,
  mainTotal: tasks.length,
  subtasksCompleted: tasks.flatMap((task) => task.checkpoints || []).filter((item) => item.completed).length,
  subtasksTotal: tasks.flatMap((task) => task.checkpoints || []).length,
};
```

Render `完成主任务：X/Y` and `完成子任务：X/Y`. Keep project acceptance/writeback unchanged.

- [ ] **Step 4: Wire the exact integration boundaries exercised by the test**

Add these four connections and no new behavior:

```js
runtime.checkpointRunner = createCheckpointRunner({
  config, runtime: automationRepo, polling, taskSync,
  policy, manager, tasks, ops, outboxWorker, clock,
});

if (!tasks.findById(change.localTaskId).checkpoints[change.checkpointIndex].completed) {
  tasks.completeCheckpoint(change.localTaskId, change.checkpointIndex);
  ops.appendEvent({
    taskId: change.localTaskId,
    kind: "checkpoint_completed",
    payload: { checkpointIndex: change.checkpointIndex, source: "feishu" },
    idempotencyKey: `feishu-checkpoint:${change.taskGuid}:${change.completedAt}`,
  });
}

await manager.handleAction({
  action: "complete",
  taskId: change.localTaskId,
  idempotencyKey: `feishu-parent:${change.taskGuid}:${change.completedAt}`,
});

automationRepo.finalizeInbound({
  messageIds,
  runKey,
  claimToken,
  chatId,
  polledThrough: pollEndTime,
});
```

`finalizeInbound` must not execute on analysis, task-sync, reply-queue, or outbox failure, and it must reject a stale claim token after lease reclamation.

- [ ] **Step 5: Verify and commit**

```bash
/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node --test
git diff --check
git status --short
git add test/checkpoint-e2e.test.mjs src/lib/daily-review.mjs test/daily-review.test.mjs docs/development-status.md
git commit -m "test: prove fixed-checkpoint execution loop"
```

Mark automated E2E passed and live polling verification pending.

---

### Task 8: Configure, Smoke-Test, and Cut Over Codex Automation

**Files:**
- Modify: `.env.example`
- Modify: `README.md`
- Modify: `docs/development-status.md`
- Test: live local Feishu tenant and Codex automation record.

**Interfaces:**
- Consumes: `npm run checkpoint`.
- Produces: one enabled local Codex automation attached to this project.
- Produces: stopped legacy WebSocket only after successful polling acceptance.

- [ ] **Step 1: Document configuration and permissions**

Add:

```text
FEISHU_P2P_CHAT_ID=
TIME_MASTER_USER_ID=
FEISHU_RECEIVE_ID=
FEISHU_RECEIVE_ID_TYPE=open_id
TIME_MASTER_TIMEZONE=Asia/Shanghai
```

Document `im:message` or `im:message:readonly`, `task:task:read`, `task:task:write`, `task:tasklist:read`, and `task:tasklist:write`. Never document real secrets or IDs.

- [ ] **Step 2: Run a read-only live poll**

```bash
/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node scripts/run-checkpoint.mjs --node=09:00 --dry-run
```

Expected shape:

```json
{"status":"dry_run","chatType":"p2p","messagesRead":1,"wouldProcess":1,"writes":0}
```

A dry run must not analyze, reply, create tasks, or advance checkpoints.

- [ ] **Step 3: Run an isolated task/subtask smoke test**

Create one `【自动化验收】` parent with two children, read them back, manually complete one child, and verify dry-run pull. Never delete an existing user task; delete the app-created test only with explicit approval or leave it clearly completed.

- [ ] **Step 4: Create one Codex local automation**

Attach it to the `N哥时间管理` project with local execution at 00:00, 08:00, 09:00, 12:00, 15:00, 18:00, and 21:00 Asia/Shanghai. Use this prompt:

```text
在 /Users/nge/Documents/Codex/N哥时间管理/NGE-time-management 运行一次固定节点时间管理：执行 npm run checkpoint。读取机器人一对一私聊新增消息、飞书主任务和子任务状态，按当前时间节点处理。没有新增消息、异常进度或计划变化时保持安静。不要启动常驻服务，不要使用飞书 WebSocket，不要重复处理已记录的 message_id。运行结束后仅记录脚本输出的 JSON 摘要；失败时保留检查点并报告明确错误。
```

Do not create seven duplicate automations.

- [ ] **Step 5: Execute real merged-message acceptance**

Send two related DMs, run forced 09:00 once, verify exactly one reply and correct disposition, run again, and verify no duplicate reply/task.

- [ ] **Step 6: Execute real task progress acceptance**

Generate one formal parent with two children, complete one child in Feishu, run 12:00 or 15:00, verify one local checkpoint completion, then complete the parent and verify evidence-required work enters `pending_acceptance`.

- [ ] **Step 7: Stop legacy service only after acceptance**

```bash
ps ax -o pid=,command= | rg '/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node scripts/run-manager.mjs$'
```

Send `SIGTERM` only to that exact PID. Do not close unrelated Terminal windows.

- [ ] **Step 8: Final verification and documentation**

```bash
/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node --test
git diff --check
git status --short
```

Update README with normal operation, missed-node catch-up, dry-run diagnosis, and automation enable/disable. Record live poll, task/subtask, idempotency, and automation results in development status.

- [ ] **Step 9: Commit**

```bash
git add .env.example README.md docs/development-status.md
git commit -m "docs: cut over to Codex checkpoint automation"
```

## Final Verification Checklist

- [ ] Full `node --test` suite passes.
- [ ] `git diff --check` passes.
- [ ] No secret, token, credential, or authorization header appears in tracked files or logs.
- [ ] Direct messages are paginated, owner-filtered, merged, and processed exactly once.
- [ ] Main tasks and real subtasks are created once and reconciled in both directions.
- [ ] Evidence-required completion enters acceptance before project progress changes.
- [ ] Quiet 09:00/12:00/15:00 checkpoints send no message.
- [ ] Missed 08:00 dispatch and 24:00 review are caught up safely.
- [ ] 18:00 and 21:00 do not overload the evening.
- [ ] One Codex automation is enabled and visible.
- [ ] Legacy WebSocket is stopped only after live polling acceptance passes.
- [ ] Rerunning a checkpoint creates no duplicate task, reply, acceptance, or project writeback.
