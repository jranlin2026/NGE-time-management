# Automated Project Execution Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn approved project Markdown into confirmed weekly plans, 70%-capacity daily Feishu work, evidence-verified completion, and automatic project-progress updates.

**Architecture:** `项目/*.md` and confirmed `周计划/*.md` remain the source of truth. Focused Markdown repositories perform validated atomic file updates; SQLite stores only operational state and idempotency; weekly, daily, acceptance, and progress services plug into the existing manager, reminder, outbox, Feishu, and recovery boundaries.

**Tech Stack:** Node.js 24 ESM, `node:sqlite`, Node built-ins, `@larksuiteoapi/node-sdk`, Codex CLI structured output, `node:test`.

## Global Constraints

- Tests use temporary knowledge-base directories; production uses the configured FounderOS knowledge-base path.
- Only content between `<!-- time-manager:managed:start -->` and `<!-- time-manager:managed:end -->` may be changed automatically.
- Preserve free-form notes byte-for-byte and reject writes when the file hash changed after reading.
- Milestone project weights and each milestone's deliverable weights must each total 100.
- Generate weekly drafts Sunday 22:00 Asia/Shanghai; generate daily work at 08:00 without daily confirmation.
- Schedule at most five tasks and at most 70% of available minutes; never schedule 12:00–14:00.
- When capacity permits, personal IP and Jixiang OS each receive at least two tasks and 120 minutes.
- Only Jixiang OS tasks marked `system_unusable_bug` may outrank personal IP.
- Project-linked tasks require evidence; AI uncertainty yields `needs_user_confirmation`, never an automatic pass.
- Preserve existing 10+10-minute coaching, 12:00 and 18:00 replanning, 24:00 review/export, outbox retry, and visible-service recovery behavior.
- Use TDD for every change and do not restart the visible production service until the complete suite passes.

Use these exact targeted commands at each task's verification step:

```bash
# Task 1
/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node --test test/project-markdown-repository.test.mjs
# Task 2
/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node --test test/database.test.mjs test/task-repository.test.mjs test/project-operations-repository.test.mjs
# Task 3
/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node --test test/weekly-plan-repository.test.mjs test/codex-analyzer.test.mjs
# Task 4
/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node --test test/weekly-planning-service.test.mjs test/feishu-cards.test.mjs test/manager-app.test.mjs
# Task 5
/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node --test test/daily-task-generator.test.mjs test/schedule-engine.test.mjs test/manager-e2e.test.mjs
# Task 6
/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node --test test/acceptance-service.test.mjs test/task-state-machine.test.mjs test/manager-service.test.mjs test/feishu-events.test.mjs
# Task 7
/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node --test test/acceptance-service.test.mjs test/project-progress-integration.test.mjs
# Task 8 and every pre-commit full check
/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node --test
```

---

### Task 1: Safe project Markdown repository

**Files:**
- Create: `src/lib/project-markdown-repository.mjs`
- Create: `test/project-markdown-repository.test.mjs`

**Interfaces:**
- Produces `createProjectMarkdownRepository({ kbDir, now?, id? })`.
- Produces `listProjects()`, `readProject(projectId)`, `ensureDraftTemplates(projectSpecs)`, `confirmDraft(projectId)`, `applyDeliverableChanges(input)`, and `acceptDeliverable(input)`.
- Produces `computeProjectProgress(project)` and `ProjectFormatError`.

- [ ] **Step 1: Write the failing read and validation tests**

```js
test("reads structured projects and computes accepted weighted progress", async () => {
  await writeProject(root, { deliverableStatus: "accepted" });
  const repo = createProjectMarkdownRepository({ kbDir: root });
  const project = await repo.readProject("personal-ip");
  assert.equal(project.milestones[0].deliverables[0].id, "video-01");
  assert.equal(computeProjectProgress(project), 10);
});

test("rejects weights that do not total one hundred", async () => {
  await writeProject(root, { milestoneWeight: 90 });
  const repo = createProjectMarkdownRepository({ kbDir: root });
  await assert.rejects(() => repo.readProject("personal-ip"), ProjectFormatError);
});
```

- [ ] **Step 2: Run RED**

Run: `/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node --test test/project-markdown-repository.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement the parser and progress formula**

```js
export function computeProjectProgress(project) {
  return Math.round(project.milestones.reduce((total, milestone) => {
    const progress = milestone.deliverables
      .filter((item) => item.status === "accepted")
      .reduce((sum, item) => sum + item.weight, 0);
    return total + progress * milestone.weight / 100;
  }, 0) * 100) / 100;
}

export function createProjectMarkdownRepository({ kbDir, now = () => new Date().toISOString(), id = randomUUID }) {
  return { listProjects, readProject, ensureDraftTemplates, confirmDraft, applyDeliverableChanges, acceptDeliverable };
}
```

Implement frontmatter, managed-section, milestone-table, and deliverable-table parsing. Validate unique IDs, statuses, markers, and weight totals. Hash the complete content with SHA-256.

`ensureDraftTemplates()` must create missing `个人IP.md` and `极享OS.md` from explicit project specs with `status: draft`, one 100-weight milestone, and one 100-weight starter deliverable. It must never replace an existing file. `confirmDraft()` changes only frontmatter status from `draft` to `active` after a hash check.

- [ ] **Step 4: Write the failing atomic-write tests**

```js
test("accepts a deliverable without changing free notes", async () => {
  const before = await repo.readProject("personal-ip");
  const result = await repo.acceptDeliverable({
    projectId: "personal-ip", deliverableId: "video-01",
    evidence: "https://example.com/v/1", expectedHash: before.contentHash,
  });
  assert.equal(result.projectProgress, 10);
  assert.match(await fs.readFile(before.filePath, "utf8"), /我的自由笔记\n不要修改/);
});

test("refuses to overwrite concurrent human edits", async () => {
  const before = await repo.readProject("personal-ip");
  await fs.appendFile(before.filePath, "\n人工修改");
  await assert.rejects(() => repo.acceptDeliverable({
    projectId: "personal-ip", deliverableId: "video-01", evidence: "x", expectedHash: before.contentHash,
  }), /project changed since read/);
});
```

- [ ] **Step 5: Implement safe writes**

Re-read and compare hashes, change only the managed region, write a sibling temporary file, rename it atomically, and create `项目变更记录/<timestamp>-<projectId>-<id>.md` containing before/after progress, evidence, and reason.

```js
const current = await readFile(project.filePath);
if (current.contentHash !== input.expectedHash) throw new Error("project changed since read");
const nextContent = replaceManagedRegion(current.rawContent, renderManaged(updatedProject));
await atomicWrite(project.filePath, nextContent);
await fs.writeFile(changeLogPath, renderChangeLog(change), "utf8");
```

- [ ] **Step 6: Verify and commit**

Run targeted test, then the full suite. Commit:

```bash
git add src/lib/project-markdown-repository.mjs test/project-markdown-repository.test.mjs
git commit -m "feat: add safe project markdown repository"
```

---

### Task 2: Operational database schema

**Files:**
- Modify: `src/db/database.mjs`
- Modify: `src/db/task-repository.mjs`
- Create: `src/db/project-operations-repository.mjs`
- Modify: `test/database.test.mjs`
- Modify: `test/task-repository.test.mjs`
- Create: `test/project-operations-repository.test.mjs`

**Interfaces:**
- Tasks gain `projectId`, `milestoneId`, `deliverableId`, `requiresEvidence`, and `impact`.
- Produces `createProjectOperationsRepository(db, deps)` for weekly plans, acceptances, and sync state.

- [ ] **Step 1: Write failing migration and task-mapping tests**

```js
const columns = db.prepare("PRAGMA table_info(tasks)").all().map((row) => row.name);
assert.ok(columns.includes("project_id"));
assert.ok(columns.includes("requires_evidence"));
for (const table of ["weekly_plans", "task_acceptances", "project_sync_state"]) {
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table));
}
```

- [ ] **Step 2: Run RED**

Run: `/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node --test test/database.test.mjs test/task-repository.test.mjs`

Expected: FAIL because migration 3 is absent.

- [ ] **Step 3: Add migration 3 and mappings**

```sql
ALTER TABLE tasks ADD COLUMN project_id TEXT;
ALTER TABLE tasks ADD COLUMN milestone_id TEXT;
ALTER TABLE tasks ADD COLUMN deliverable_id TEXT;
ALTER TABLE tasks ADD COLUMN requires_evidence INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN impact TEXT NOT NULL DEFAULT 'normal';
CREATE TABLE weekly_plans (week_id TEXT NOT NULL, version INTEGER NOT NULL, markdown_path TEXT NOT NULL, content_hash TEXT NOT NULL, status TEXT NOT NULL, plan_json TEXT NOT NULL, created_at TEXT NOT NULL, confirmed_at TEXT, confirmation_event_id TEXT UNIQUE, PRIMARY KEY(week_id, version));
CREATE TABLE task_acceptances (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, deliverable_id TEXT NOT NULL, evidence_json TEXT NOT NULL, status TEXT NOT NULL, explanation TEXT NOT NULL, idempotency_key TEXT UNIQUE, created_at TEXT NOT NULL, decided_at TEXT, FOREIGN KEY(task_id) REFERENCES tasks(id));
CREATE TABLE project_sync_state (project_id TEXT PRIMARY KEY, file_path TEXT NOT NULL, content_hash TEXT NOT NULL, last_written_version INTEGER NOT NULL DEFAULT 0, last_error TEXT, updated_at TEXT NOT NULL);
```

Extend task insertion, update allowlist, and mapping; use `Boolean(row.requires_evidence)`.

- [ ] **Step 4: Write failing repository tests**

```js
repo.saveWeeklyPlan({ weekId: "2026-W29", version: 1, markdownPath: "/x.md", contentHash: "abc", status: "draft", plan: { tasks: [] } });
repo.confirmWeeklyPlan({ weekId: "2026-W29", version: 1, eventId: "evt-1" });
repo.confirmWeeklyPlan({ weekId: "2026-W29", version: 1, eventId: "evt-1" });
assert.equal(repo.getConfirmedWeeklyPlan("2026-W29").status, "confirmed");
```

- [ ] **Step 5: Implement repository methods**

Implement `saveWeeklyPlan`, `getWeeklyPlan`, `getLatestWeeklyPlan`, `getConfirmedWeeklyPlan`, `confirmWeeklyPlan`, `saveAcceptance`, `getAcceptance`, `findPendingAcceptanceByTask`, `decideAcceptance`, `getSyncState`, and `saveSyncState`. Parse/stringify JSON columns and use unique keys for idempotency.

```js
export function createProjectOperationsRepository(db, deps = {}) {
  return {
    saveWeeklyPlan, getWeeklyPlan, getLatestWeeklyPlan, getConfirmedWeeklyPlan,
    confirmWeeklyPlan, saveAcceptance, getAcceptance, findPendingAcceptanceByTask,
    decideAcceptance, getSyncState, saveSyncState,
  };
}
```

- [ ] **Step 6: Verify and commit**

Run the three targeted test files and full suite. Commit as `feat: persist project execution state`.

---

### Task 3: Weekly-plan Markdown and Codex planning

**Files:**
- Create: `src/lib/weekly-plan-repository.mjs`
- Create: `src/lib/codex-weekly-plan-schema.json`
- Modify: `src/lib/codex-analyzer.mjs`
- Create: `test/weekly-plan-repository.test.mjs`
- Modify: `test/codex-analyzer.test.mjs`

**Interfaces:**
- Produces `createWeeklyPlanRepository({ kbDir })` with `writeDraft`, `read`, and `confirm`.
- Adds `analyzeWeeklyPlan({ weekId, projects, previousPlan })` returning `{ outcomes, deliverableChanges, tasks, analysisStatus }`.

- [ ] **Step 1: Write failing weekly Markdown tests**

```js
const draft = await repo.writeDraft({ weekId: "2026-W29", version: 1, plan });
assert.match(await fs.readFile(draft.filePath, "utf8"), /status: draft/);
const confirmed = await repo.confirm({ weekId: "2026-W29", version: 1, expectedHash: draft.contentHash });
assert.equal(confirmed.status, "confirmed");
```

- [ ] **Step 2: Run RED and implement repository**

Write `周计划/<weekId>.md` atomically with fields `week_id`, `version`, `status`, `created_at`, `confirmed_at`, outcomes, deliverable changes, and a task table containing `task_id`, `project_id`, `project_name`, milestone/deliverable IDs, title, deliverable, completion standard, minutes, date, evidence flag, and impact. Reject confirmation on hash mismatch.

```js
export function createWeeklyPlanRepository({ kbDir, now = () => new Date().toISOString() }) {
  return { writeDraft, read, confirm };
}

async function confirm({ weekId, version, expectedHash }) {
  const current = await read(weekId);
  if (current.version !== version || current.contentHash !== expectedHash) throw new Error("weekly plan changed since read");
  return atomicWritePlan({ ...current, status: "confirmed", confirmedAt: now() });
}
```

- [ ] **Step 3: Write failing analyzer and fallback tests**

```js
const result = await analyzer.analyzeWeeklyPlan({ weekId: "2026-W29", projects, previousPlan: null });
assert.equal(result.tasks[0].deliverableId, "video-01");

const fallback = await offlineAnalyzer.analyzeWeeklyPlan({ weekId: "2026-W29", projects, previousPlan: null });
assert.equal(fallback.analysisStatus, "failed");
assert.equal(fallback.tasks[0].deliverableId, "video-01");
```

- [ ] **Step 4: Implement schema, prompt, validation, and fallback**

Require all task fields and restrict impact to `normal` or `system_unusable_bug`. Reject unknown IDs unless the same plan proposes the matching deliverable. Fallback selects existing pending deliverables without creating scope.

```js
async analyzeWeeklyPlan({ weekId, projects, previousPlan = null }) {
  try {
    const parsed = JSON.parse(await run({ mode: "weekly_plan", schemaPath: WEEKLY_PLAN_SCHEMA, prompt: buildWeeklyPrompt({ weekId, projects, previousPlan }) }));
    validateWeeklyPlan(parsed, projects);
    return { ...parsed, analysisStatus: "complete" };
  } catch (error) {
    return fallbackWeeklyPlan({ weekId, projects, error });
  }
}
```

- [ ] **Step 5: Verify and commit**

Run both targeted files and full suite. Commit as `feat: generate structured weekly plan drafts`.

---

### Task 4: Weekly planning service and Feishu confirmation

**Files:**
- Create: `src/lib/weekly-planning-service.mjs`
- Modify: `src/lib/feishu-cards.mjs`
- Modify: `src/lib/feishu-messages.mjs`
- Modify: `src/manager-app.mjs`
- Create: `test/weekly-planning-service.test.mjs`
- Modify: `test/feishu-cards.test.mjs`
- Modify: `test/manager-app.test.mjs`

**Interfaces:**
- Produces `createWeeklyPlanningService(deps)` with `generateDraft`, `confirm`, `requestAdjustment`, and `getEffectivePlan`.
- Produces `renderWeeklyPlanCard({ plan, weekId, version })`.
- Produces `renderProjectSetupCard({ projects })` and actions `confirm_project_setup`, `confirm_weekly_plan`, and `adjust_weekly_plan`.

- [ ] **Step 1: Write failing service tests**

```js
const result = await service.generateDraft({ weekId: "2026-W29" });
assert.equal(result.status, "draft");
assert.equal(ops.listOutbox().at(-1).kind, "weekly_plan_card");

const effective = await service.getEffectivePlan({ weekId: "2026-W29", previousWeekId: "2026-W28" });
assert.equal(effective.weekId, "2026-W28");
```

- [ ] **Step 2: Run RED and implement service**

Generate a versioned draft, save both stores, and enqueue one confirmation card. Confirmation applies only the confirmed draft's deliverable changes, updates Markdown and SQLite, and records `weekly_plan_confirmed`. An unconfirmed current week returns the prior confirmed plan.

```js
export function createWeeklyPlanningService(deps) {
  return { generateDraft, confirm, requestAdjustment, getEffectivePlan };
}

async function getEffectivePlan({ weekId, previousWeekId }) {
  return projectOps.getConfirmedWeeklyPlan(weekId)
    || projectOps.getConfirmedWeeklyPlan(previousWeekId)
    || null;
}
```

- [ ] **Step 3: Write failing card and callback tests**

```js
const card = renderWeeklyPlanCard({ plan, weekId: "2026-W29", version: 1 });
assert.deepEqual(allActions(card), ["confirm_weekly_plan", "adjust_weekly_plan"]);
const setupCard = renderProjectSetupCard({ projects: draftProjects });
assert.deepEqual(allActions(setupCard), ["confirm_project_setup"]);
const response = await callback(confirmEvent);
assert.match(JSON.stringify(response.card), /周计划已确认/);
```

- [ ] **Step 4: Implement synchronous callback routing**

On startup, call `ensureDraftTemplates()` with the approved personal-IP and Jixiang-OS project specs. If any project remains `draft`, enqueue one `project_setup_card` and skip weekly generation. `confirm_project_setup` activates both draft files through `confirmDraft()` and updates the source card. Normalize `weekId` and numeric `version`. Weekly confirmation must await the service and return an updated source card. Adjustment prompts `调整周计划｜具体原因` and leaves the draft inactive.

```js
if (action.action === "confirm_weekly_plan") {
  const plan = await weeklyPlanning.confirm({ weekId: action.weekId, version: Number(action.version), eventId: action.idempotencyKey });
  return { toast: { type: "success", content: "周计划已确认" }, card: renderConfirmedWeeklyPlanCard(plan) };
}
```

- [ ] **Step 5: Verify and commit**

Run the three targeted files and full suite. Commit as `feat: confirm weekly plans in Feishu`.

---

### Task 5: Confirmed plan to 70%-capacity daily schedule

**Files:**
- Create: `src/lib/daily-task-generator.mjs`
- Modify: `src/lib/schedule-engine.mjs`
- Modify: `src/lib/manager-service.mjs`
- Modify: `src/manager-app.mjs`
- Create: `test/daily-task-generator.test.mjs`
- Modify: `test/schedule-engine.test.mjs`
- Modify: `test/manager-e2e.test.mjs`

**Interfaces:**
- Produces `createDailyTaskGenerator({ tasks, projectOps })` with `materialize({ weekId, date })`.
- Produces pure `isoWeekId(date)` for daily runtime lookup.
- Adds schedule settings `capacityRatio` and `projectMinimumMinutes`.

- [ ] **Step 1: Write failing materialization tests**

```js
const created = await generator.materialize({ weekId: "2026-W29", date: "2026-07-13" });
assert.equal(created[0].projectId, "personal-ip");
assert.equal(created[0].requiresEvidence, true);
await generator.materialize({ weekId: "2026-W29", date: "2026-07-13" });
assert.equal(tasks.listAll().filter((item) => item.deliverableId === "video-01").length, 1);
```

- [ ] **Step 2: Run RED and implement materialization**

Read only the confirmed weekly plan. Create stable task IDs `weekly:<weekId>:<weeklyTaskId>` and copy all project linkage, evidence, impact, time, next action, and completion-standard fields.

```js
export function createDailyTaskGenerator({ tasks, projectOps }) {
  return { materialize };
  async function materialize({ weekId, date }) {
    const row = projectOps.getConfirmedWeeklyPlan(weekId);
    if (!row) return [];
    return row.plan.tasks.filter((item) => item.suggestedDate === date)
      .map((item) => tasks.create({
        id: `weekly:${weekId}:${item.taskId}`, rawInput: item.title, title: item.title,
        project: item.projectName, projectId: item.projectId, milestoneId: item.milestoneId,
        deliverableId: item.deliverableId, requiresEvidence: item.requiresEvidence,
        impact: item.impact, estimateMinutes: item.estimateMinutes,
        nextAction: item.nextAction, doneDefinition: item.doneDefinition, status: "ready",
      }));
  }
}

export function isoWeekId(date) {
  const value = new Date(`${date}T00:00:00.000Z`);
  const day = value.getUTCDay() || 7;
  value.setUTCDate(value.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(value.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((value - yearStart) / 86400000) + 1) / 7);
  return `${value.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}
```

- [ ] **Step 3: Write failing capacity and override tests**

```js
const minutes = schedule.blocks.reduce((sum, block) => sum + (new Date(block.endsAt) - new Date(block.startsAt)) / 60000, 0);
assert.ok(minutes <= 504);
assert.equal(normalOsSchedule.blocks[0].taskId, ipTask.id);
assert.equal(unusableBugSchedule.blocks[0].taskId, osTask.id);
```

- [ ] **Step 4: Implement capacity budget and override**

Compute `floor(sum(window minutes) * capacityRatio)`, track scheduled minutes, and cap every block by remaining capacity. Add an override score only for `project === "极享OS" && impact === "system_unusable_bug"`. Return capacity warnings instead of breaking the 70% cap when project minimums cannot fit.

```js
const blockMinutes = (sum, block) => sum + (new Date(block.endsAt) - new Date(block.startsAt)) / 60000;
const minutesBetweenClockTimes = (start, end) => {
  const [startHour, startMinute] = start.split(":").map(Number);
  const [endHour, endMinute] = end.split(":").map(Number);
  return (endHour * 60 + endMinute) - (startHour * 60 + startMinute);
};
const windowMinutes = (definitions) => definitions.reduce((sum, [start, end]) => sum + minutesBetweenClockTimes(start, end), 0);
const capacityLimitMinutes = Math.floor(windowMinutes(settings.windows) * Number(settings.capacityRatio || 1));
const budgetRemaining = () => capacityLimitMinutes - blocks.reduce(blockMinutes, 0);
const minutes = Math.min(remaining, available, 120, budgetRemaining());
if (minutes <= 0) break;
```

- [ ] **Step 5: Integrate daily dispatch**

Materialize before `dispatchDay()` replans. Render capacity warnings in the daily card. Keep current-task blocks stable during replan.

```js
async function dispatchDay(options = {}) {
  await dailyTaskGenerator.materialize({ weekId: isoWeekId(options.date), date: options.date });
  return replanDay({ ...options, reason: "daily_plan" });
}
```

- [ ] **Step 6: Verify and commit**

Run all three targeted files and full suite. Commit as `feat: schedule confirmed weekly work at seventy percent capacity`.

---

### Task 6: Evidence collection and acceptance decisions

**Files:**
- Create: `src/lib/acceptance-service.mjs`
- Create: `src/lib/codex-acceptance-schema.json`
- Modify: `src/lib/codex-analyzer.mjs`
- Modify: `src/lib/task-state-machine.mjs`
- Modify: `src/lib/manager-service.mjs`
- Modify: `src/lib/feishu-events.mjs`
- Modify: `src/lib/feishu-cards.mjs`
- Create: `test/acceptance-service.test.mjs`
- Modify: `test/task-state-machine.test.mjs`
- Modify: `test/manager-service.test.mjs`
- Modify: `test/feishu-events.test.mjs`

**Interfaces:**
- Produces `createAcceptanceService(deps)` with `request`, `submit`, and `decideByUser`.
- Adds `analyzeAcceptance({ task, evidence })` returning accepted/rejected/manual-review status.

- [ ] **Step 1: Write failing completion-routing tests**

```js
const result = await manager.handleAction({ action: "complete", taskId: critical.id, idempotencyKey: "complete-1" });
assert.equal(result.action, "evidence_required");
assert.equal(tasks.findById(critical.id).status, "pending_acceptance");
assert.equal(ops.listOutbox().at(-1).kind, "evidence_request_card");
```

- [ ] **Step 2: Run RED and implement state routing**

Add `doing -> pending_acceptance` and `pending_acceptance -> done/doing/cancelled`. Route project-linked completion before direct completion, persist a pending acceptance, and enqueue evidence request. Ordinary completion remains unchanged.

```js
if (input.action === "complete" && task.requiresEvidence) {
  const pending = await acceptance.request(task, { idempotencyKey: input.idempotencyKey });
  return { action: "evidence_required", task: tasks.findById(task.id), acceptance: pending };
}
```

- [ ] **Step 3: Write failing evidence and AI-failure tests**

```js
assert.deepEqual(normalizeEvidenceMessage("提交结果：发布视频｜https://example.com/v/1").evidence, [{ type: "url", value: "https://example.com/v/1" }]);
assert.equal(extractMessageText(imageEvent).evidence[0].type, "feishu_image");
assert.equal((await offlineService.submit(input)).status, "needs_user_confirmation");
```

- [ ] **Step 4: Implement deterministic and AI acceptance**

Check URL, quantity, and file-reference rules before AI. Restrict the Codex output to `accepted`, `rejected`, or `needs_user_confirmation`. Any analyzer/evidence error returns manual review. An unreadable Feishu image reference renders manual accept/reject buttons.

```js
export function createAcceptanceService(deps) {
  return { request, submit, decideByUser };
}

async function safeAnalyze(input) {
  try { return await analyzer.analyzeAcceptance(input); }
  catch (error) { return { status: "needs_user_confirmation", explanation: String(error.message || error) }; }
}
```

- [ ] **Step 5: Verify and commit**

Run the four targeted files and full suite. Commit as `feat: require evidence for project deliverables`.

---

### Task 7: Idempotent project-progress writeback

**Files:**
- Modify: `src/lib/acceptance-service.mjs`
- Modify: `src/lib/project-markdown-repository.mjs`
- Modify: `src/lib/manager-service.mjs`
- Modify: `src/lib/feishu-cards.mjs`
- Create: `test/project-progress-integration.test.mjs`
- Modify: `test/acceptance-service.test.mjs`

**Interfaces:**
- Accepted evidence calls `projectRepo.acceptDeliverable()` exactly once.
- Produces `project_progress_card`; rejection produces one rework task on the same deliverable.

- [ ] **Step 1: Write failing accepted-progress test**

```js
const first = await service.submit({ taskId: "critical", evidence, idempotencyKey: "evidence-1" });
const second = await service.submit({ taskId: "critical", evidence, idempotencyKey: "evidence-1" });
assert.equal(second.acceptanceId, first.acceptanceId);
assert.equal(tasks.findById("critical").status, "done");
assert.equal((await projectRepo.readProject("personal-ip")).progress, 10);
assert.equal(ops.listEvents({ taskId: "critical", kind: "task_accepted" }).length, 1);
```

- [ ] **Step 2: Run RED and implement accepted writeback**

Read task, pending acceptance, project, and hash; update Markdown atomically; then decide acceptance, mark done, append `task_accepted`, save sync state, and enqueue progress card in one SQLite transaction. If SQLite fails after the file write, record `project_sync_reconciliation_required`; recovery reads accepted Markdown instead of applying progress again.

```js
const project = await projectRepo.readProject(task.projectId);
const write = await projectRepo.acceptDeliverable({ projectId: task.projectId, deliverableId: task.deliverableId, evidence: evidenceSummary, expectedHash: project.contentHash });
return transaction(() => finalizeAccepted({ task, acceptance, write, idempotencyKey }));
```

- [ ] **Step 3: Write failing rejection/manual tests**

```js
const rejected = await service.submit(rejectedInput);
assert.equal(tasks.findById(rejected.reworkTaskId).deliverableId, "video-01");
const manual = await service.decideByUser({ acceptanceId: "a1", decision: "accepted", idempotencyKey: "manual-1" });
assert.equal(manual.status, "accepted");
```

- [ ] **Step 4: Implement rejection and progress card**

Restore the original task to doing, create stable ID `rework:<acceptanceId>`, preserve evidence requirement, and place the rejection explanation in the next action. The progress card shows deliverable, evidence, before/after progress, and next candidate.

```js
const rework = tasks.create({
  id: `rework:${acceptance.id}`, projectId: task.projectId, milestoneId: task.milestoneId,
  deliverableId: task.deliverableId, requiresEvidence: true,
  title: `返工：${task.title}`, nextAction: decision.explanation,
});
```

- [ ] **Step 5: Verify and commit**

Run both targeted files and full suite. Commit as `feat: write accepted progress to project markdown`.

---

### Task 8: Runtime scheduling, recovery, E2E, and documentation

**Files:**
- Modify: `src/config.mjs`
- Modify: `src/manager-app.mjs`
- Modify: `src/lib/recovery.mjs`
- Modify: `test/config.test.mjs`
- Modify: `test/manager-app.test.mjs`
- Modify: `test/recovery.test.mjs`
- Modify: `test/manager-e2e.test.mjs`
- Modify: `README.md`
- Modify: `docs/development-status.md`

**Interfaces:**
- Adds `schedule.weeklyPlan = "22:00"`, `capacityRatio = 0.7`, Sunday reminder kind `weekly_plan`, and full service composition.

- [ ] **Step 1: Write failing weekly reminder and recovery tests**

```js
seedFixedReminders({ now: new Date("2026-07-12T00:00:00.000Z"), config, settings, ops });
const weekly = ops.listReminders({ status: "pending" }).find((item) => item.kind === "weekly_plan");
assert.equal(weekly.dueAt, "2026-07-12T14:00:00.000Z");
await recoverManagerState({ ...deps, reconcileProjects });
assert.equal(ops.listEvents({ kind: "project_sync_reconciled" }).length, 1);
```

- [ ] **Step 2: Run RED and compose runtime**

```js
const projectRepo = createProjectMarkdownRepository({ kbDir: config.kbDir });
const projectOps = createProjectOperationsRepository(db);
const weeklyPlans = createWeeklyPlanRepository({ kbDir: config.kbDir });
const weeklyPlanning = createWeeklyPlanningService({ projectRepo, projectOps, weeklyPlans, analyzer, ops, transaction });
const dailyTaskGenerator = createDailyTaskGenerator({ tasks, projectOps });
const acceptance = createAcceptanceService({ tasks, ops, projectOps, projectRepo, analyzer, transaction });
```

Seed four Sunday reminders using `fixed:weekly-plan:<weekId>`. Wire weekly generation, daily materialization, evidence messages, card callbacks, outbox cards, and project reconciliation into the existing app.

- [ ] **Step 3: Write the full E2E test**

```js
await app.state.weeklyPlanning.generateDraft({ weekId: "2026-W29" });
await app.state.weeklyPlanning.confirm({ weekId: "2026-W29", version: 1, eventId: "confirm-1" });
await app.state.manager.dispatchDay({ date: "2026-07-13", now: "2026-07-13T00:00:00.000Z" });
const task = app.state.tasks.listActive().find((item) => item.deliverableId === "video-01");
await app.state.manager.handleAction({ action: "start", taskId: task.id, idempotencyKey: "start-1" });
await app.state.manager.handleAction({ action: "complete", taskId: task.id, idempotencyKey: "complete-1" });
await app.state.acceptance.submit({ taskId: task.id, evidence: [{ type: "url", value: "https://example.com/v/1" }], idempotencyKey: "evidence-1" });
assert.equal(app.state.tasks.findById(task.id).status, "done");
assert.equal((await app.state.projectRepo.readProject("personal-ip")).progress, 10);
```

- [ ] **Step 4: Run complete verification**

```bash
/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node --test
git diff --check
```

Expected: all tests PASS; diff check prints nothing.

- [ ] **Step 5: Update operator documentation**

Document the project template, Sunday confirmation, Monday fallback, 70% capacity warnings, `提交结果：任务名｜链接或说明`, manual image acceptance, recovery, and visible-service verification. Update progress rows only after the matching commits and tests exist.

- [ ] **Step 6: Commit**

```bash
git add src/config.mjs src/manager-app.mjs src/lib/recovery.mjs test/config.test.mjs test/manager-app.test.mjs test/recovery.test.mjs test/manager-e2e.test.mjs README.md docs/development-status.md
git commit -m "feat: automate project execution loop"
```

- [ ] **Step 7: Restart and perform visible Feishu acceptance**

After tests pass, restart only the PID returned by `pgrep -alf 'scripts/run-manager.mjs'` in a visible Terminal window. Verify low idle CPU and at least one established TCP connection with `ps` and `lsof`. Run one live path in the private group: weekly draft → confirm → daily plan → start → complete → submit evidence → verify project Markdown and change log. Do not test destructive recovery or rejection with production evidence.
