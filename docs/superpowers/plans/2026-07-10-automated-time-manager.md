# Automated Time Manager Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Mac-resident personal time manager that accepts all tasks through Feishu, uses local Codex for structured understanding, applies deterministic scheduling rules, actively manages the day, survives restarts, and produces an evening review.

**Architecture:** A single Node.js 24 daemon, supervised by macOS `launchd`, owns a SQLite database and a durable reminder loop. Feishu is the only interaction channel; local Codex returns schema-constrained suggestions, while deterministic application code owns state transitions, scheduling, retries, and recovery.

**Tech Stack:** Node.js 24 ESM, built-in `node:sqlite`, built-in `node:test`, `@larksuiteoapi/node-sdk`, Feishu OpenAPI/WebSocket, local `codex exec`, macOS `launchd`.

## Global Constraints

- Manage one user only; do not add team assignment or multi-user permissions.
- Feishu is the only task input and feedback channel.
- SQLite is the source of truth; Feishu and Markdown are projections.
- Local `codex exec` may suggest structured fields but may not write the database or call Feishu.
- The deterministic rule engine owns task limits, working hours, time blocks, state transitions, reminder escalation, and conflict resolution.
- Send no more than 1–3 critical tasks in a daily plan.
- Default cadence is 08:30 plan, 10:00 first task, 12:00 recalibration, 14:00–18:00 afternoon execution, 18:00 close, and 20:00–22:00 evening work and review.
- First no-response check occurs after 15 minutes; the second occurs 15 minutes later and creates one procrastination event plus a 15-minute minimum action.
- Card buttons and text commands must produce the same state transitions.
- Use local timezone `Asia/Shanghai` and store timestamps as ISO 8601 UTC strings.
- Preserve existing Feishu message, task-list, prioritizer, and Markdown tests until their replacements pass.
- Use test-driven development and commit after each task.
- Before running Node commands in the Codex desktop environment, export `PATH="/Users/nge/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH"`; the installed LaunchAgent uses the absolute `process.execPath` captured during installation.

---

## Planned File Structure

### New production files

- `src/db/database.mjs` — open SQLite, apply schema migrations, configure WAL and transactions.
- `src/db/task-repository.mjs` — create, query, update, and migrate tasks.
- `src/db/operations-repository.mjs` — persist task events, schedule versions, reminders, daily reviews, and outbox rows.
- `src/lib/codex-analyzer.mjs` — invoke `codex exec`, validate its JSON result, and return deterministic fallbacks.
- `src/lib/codex-task-schema.json` — JSON Schema for Codex task analysis output.
- `src/lib/schedule-engine.mjs` — pure scoring and time-block generation.
- `src/lib/task-state-machine.mjs` — legal task transitions and status feedback handling.
- `src/lib/reminder-engine.mjs` — create and process durable reminders, including two-stage no-response handling.
- `src/lib/recovery.mjs` — invalidate stale reminders and create a recovery plan after restart or wake.
- `src/lib/feishu-cards.mjs` — render daily-plan, current-task, intervention, and review cards.
- `src/lib/feishu-messages.mjs` — send text/cards through Feishu OpenAPI and normalize card events.
- `src/lib/outbox-worker.mjs` — deliver and retry durable Feishu operations.
- `src/lib/manager-service.mjs` — orchestrate intake, state feedback, replanning, and review.
- `src/lib/daily-review.mjs` — derive the evening summary from task and event facts.
- `src/lib/markdown-export.mjs` — export daily plan/review from SQLite without reading changes back.
- `src/db/backup.mjs` — create verified SQLite backups and retain the newest seven files.
- `src/manager-app.mjs` — compose dependencies and expose start/stop lifecycle.
- `scripts/run-manager.mjs` — production daemon entry point.
- `scripts/install-launchd.mjs` — write and load a user LaunchAgent using the current Node executable.
- `scripts/uninstall-launchd.mjs` — unload and remove that LaunchAgent.

### New tests

- `test/database.test.mjs`
- `test/task-repository.test.mjs`
- `test/codex-analyzer.test.mjs`
- `test/schedule-engine.test.mjs`
- `test/task-state-machine.test.mjs`
- `test/reminder-engine.test.mjs`
- `test/recovery.test.mjs`
- `test/feishu-cards.test.mjs`
- `test/outbox-worker.test.mjs`
- `test/manager-service.test.mjs`
- `test/daily-review.test.mjs`
- `test/manager-e2e.test.mjs`
- `test/backup.test.mjs`
- `test/launchd.test.mjs`

### Existing files to modify

- `package.json` — require Node 24 and add manager/launchd scripts.
- `src/config.mjs` — add database, Codex, schedule, user, and runtime configuration.
- `src/lib/feishu-events.mjs` — route inbound text into `manager-service` while keeping the current extraction helpers.
- `scripts/feishu-listen.mjs` — move listener registration into the composed manager app and add card-action registration.
- `README.md` — document Mac setup, launchd management, commands, and operational checks.
- `docs/feishu-setup.md` — document card events and required Feishu app capabilities.

---

### Task 1: SQLite Foundation and Runtime Configuration

**Files:**
- Create: `src/db/database.mjs`
- Create: `test/database.test.mjs`
- Modify: `src/config.mjs`
- Modify: `package.json`
- Modify: `.gitignore`

**Interfaces:**
- Produces: `openDatabase(filePath: string): DatabaseSync`
- Produces: `withTransaction(db: DatabaseSync, fn: () => T): T`
- Produces: config fields `dataDir`, `dbPath`, `backupDir`, `codexBin`, `timezone`, `schedule`, `managerUserId`, `feishuReceiveId`, `feishuReceiveIdType`, `markdownExportDir`

- [ ] **Step 1: Write the failing database migration test**

```js
// test/database.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { openDatabase } from "../src/db/database.mjs";

test("opens a WAL database and creates all version-one tables", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "time-manager-db-"));
  const db = openDatabase(path.join(dir, "manager.sqlite"));
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name);
  assert.equal(db.prepare("PRAGMA journal_mode").get().journal_mode, "wal");
  for (const name of ["schema_migrations", "tasks", "task_events", "schedule_blocks", "reminders", "outbox", "daily_reviews", "settings"]) {
    assert.ok(tables.includes(name), `missing table ${name}`);
  }
  db.close();
});
```

- [ ] **Step 2: Run the test and verify the missing module failure**

Run:

```bash
node --test test/database.test.mjs
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/db/database.mjs`.

- [ ] **Step 3: Add the SQLite schema and transaction helper**

Create `src/db/database.mjs` with `DatabaseSync` from `node:sqlite`. The migration must execute these exact table definitions inside one transaction:

```js
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const MIGRATION_1 = `
CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, project TEXT NOT NULL DEFAULT '未归类', raw_input TEXT NOT NULL,
  quadrant TEXT NOT NULL DEFAULT '重要不紧急', importance TEXT NOT NULL DEFAULT 'B', urgency TEXT NOT NULL DEFAULT 'medium',
  due_at TEXT, status TEXT NOT NULL DEFAULT 'inbox', next_action TEXT NOT NULL, done_definition TEXT NOT NULL,
  estimate_minutes INTEGER NOT NULL DEFAULT 30, blocker TEXT NOT NULL DEFAULT '', procrastination_count INTEGER NOT NULL DEFAULT 0,
  source_message_id TEXT UNIQUE, analysis_status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS task_events (
  id TEXT PRIMARY KEY, task_id TEXT, kind TEXT NOT NULL, payload_json TEXT NOT NULL DEFAULT '{}',
  idempotency_key TEXT UNIQUE, occurred_at TEXT NOT NULL, FOREIGN KEY(task_id) REFERENCES tasks(id)
);
CREATE TABLE IF NOT EXISTS schedule_blocks (
  id TEXT PRIMARY KEY, schedule_date TEXT NOT NULL, version INTEGER NOT NULL, task_id TEXT NOT NULL,
  starts_at TEXT NOT NULL, ends_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'planned', reason TEXT NOT NULL,
  replaced_by_version INTEGER, created_at TEXT NOT NULL, FOREIGN KEY(task_id) REFERENCES tasks(id)
);
CREATE TABLE IF NOT EXISTS reminders (
  id TEXT PRIMARY KEY, task_id TEXT, kind TEXT NOT NULL, due_at TEXT NOT NULL, expires_at TEXT,
  status TEXT NOT NULL DEFAULT 'pending', attempt INTEGER NOT NULL DEFAULT 0, fired_at TEXT,
  idempotency_key TEXT UNIQUE, created_at TEXT NOT NULL, FOREIGN KEY(task_id) REFERENCES tasks(id)
);
CREATE TABLE IF NOT EXISTS outbox (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, payload_json TEXT NOT NULL, idempotency_key TEXT UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TEXT NOT NULL,
  external_id TEXT, last_error TEXT, created_at TEXT NOT NULL, sent_at TEXT
);
CREATE TABLE IF NOT EXISTS daily_reviews (
  review_date TEXT PRIMARY KEY, summary_json TEXT NOT NULL, rendered_text TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_tasks_status_due ON tasks(status, due_at);
CREATE INDEX IF NOT EXISTS idx_blocks_date_version ON schedule_blocks(schedule_date, version);
CREATE INDEX IF NOT EXISTS idx_reminders_due ON reminders(status, due_at);
CREATE INDEX IF NOT EXISTS idx_outbox_due ON outbox(status, next_attempt_at);
`;

export function openDatabase(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const db = new DatabaseSync(filePath);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  const applied = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations'").get();
  if (!applied || !db.prepare("SELECT 1 FROM schema_migrations WHERE version = 1").get()) {
    withTransaction(db, () => {
      db.exec(MIGRATION_1);
      db.prepare("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(1, new Date().toISOString());
    });
  }
  return db;
}

export function withTransaction(db, fn) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const value = fn();
    db.exec("COMMIT");
    return value;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
```

- [ ] **Step 4: Add explicit Mac runtime configuration**

Modify `src/config.mjs` so `loadConfig()` adds these fields while retaining all existing Feishu fields:

```js
const dataDir = path.resolve(merged.TIME_MASTER_DATA_DIR || path.join(process.cwd(), "data"));
const schedule = {
  plan: merged.TIME_MASTER_PLAN_TIME || "08:30",
  firstTask: merged.TIME_MASTER_FIRST_TASK_TIME || "10:00",
  midday: merged.TIME_MASTER_MIDDAY_TIME || "12:00",
  afternoon: merged.TIME_MASTER_AFTERNOON_TIME || "14:00",
  dayClose: merged.TIME_MASTER_DAY_CLOSE_TIME || "18:00",
  eveningStart: merged.TIME_MASTER_EVENING_START || "20:00",
  eveningEnd: merged.TIME_MASTER_EVENING_END || "22:00",
  noResponseMinutes: Number(merged.TIME_MASTER_NO_RESPONSE_MINUTES || 15),
};

return {
  // retain existing fields
  dataDir,
  dbPath: path.resolve(merged.TIME_MASTER_DB_PATH || path.join(dataDir, "time-manager.sqlite")),
  backupDir: path.resolve(merged.TIME_MASTER_BACKUP_DIR || path.join(dataDir, "backups")),
  markdownExportDir: path.resolve(merged.TIME_MASTER_MARKDOWN_DIR || path.join(dataDir, "exports")),
  codexBin: merged.CODEX_BIN || "/Applications/ChatGPT.app/Contents/Resources/codex",
  timezone: merged.TIME_MASTER_TIMEZONE || "Asia/Shanghai",
  managerUserId: merged.TIME_MASTER_USER_ID || "",
  feishuReceiveId: merged.FEISHU_RECEIVE_ID || "",
  feishuReceiveIdType: merged.FEISHU_RECEIVE_ID_TYPE || "open_id",
  schedule,
};
```

Modify `package.json` with:

```json
"engines": { "node": ">=24.0.0" },
"scripts": {
  "manager": "node scripts/run-manager.mjs",
  "manager:install": "node scripts/install-launchd.mjs",
  "manager:uninstall": "node scripts/uninstall-launchd.mjs"
}
```

Merge these scripts with the existing script entries; do not remove current commands.

Add these lines to `.gitignore` so local state and credentials cannot be committed:

```gitignore
data/
*.sqlite
*.sqlite-shm
*.sqlite-wal
```

- [ ] **Step 5: Run the database test and the existing suite**

Run:

```bash
node --test test/database.test.mjs
npm test
```

Expected: database test PASS; existing tests PASS.

- [ ] **Step 6: Commit the storage foundation**

```bash
git add .gitignore package.json src/config.mjs src/db/database.mjs test/database.test.mjs
git commit -m "feat: add sqlite storage foundation"
```

---

### Task 2: Task, Event, Schedule, Reminder, and Outbox Repositories

**Files:**
- Create: `src/db/task-repository.mjs`
- Create: `src/db/operations-repository.mjs`
- Create: `test/task-repository.test.mjs`
- Modify: `src/lib/task-store.mjs`

**Interfaces:**
- Consumes: `withTransaction(db, fn)` from Task 1
- Produces: `createTaskRepository(db, { now, id })`
- Produces: `createOperationsRepository(db, { now, id })`
- Produces task methods `create`, `findById`, `findBySourceMessageId`, `listActive`, `update`, `importMarkdown`
- Produces operations methods `appendEvent`, `replaceSchedule`, `currentSchedule`, `enqueueReminder`, `dueReminders`, `enqueueOutbox`, `dueOutbox`, `saveReview`, `getSetting`, `setSetting`

- [ ] **Step 1: Write repository tests for idempotency, task updates, and atomic outbox creation**

```js
// test/task-repository.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { openDatabase, withTransaction } from "../src/db/database.mjs";
import { createTaskRepository } from "../src/db/task-repository.mjs";
import { createOperationsRepository } from "../src/db/operations-repository.mjs";

const NOW = "2026-07-10T00:30:00.000Z";

test("creates one task per Feishu message and records an event plus outbox atomically", () => {
  const db = openDatabase(":memory:");
  let n = 0;
  const ids = () => `id-${++n}`;
  const tasks = createTaskRepository(db, { now: () => NOW, id: ids });
  const ops = createOperationsRepository(db, { now: () => NOW, id: ids });
  const first = withTransaction(db, () => {
    const task = tasks.create({ rawInput: "拍 3 条视频", sourceMessageId: "om-1" });
    ops.appendEvent({ taskId: task.id, kind: "task_created", idempotencyKey: "msg:om-1" });
    ops.enqueueOutbox({ kind: "text", payload: { text: "已入池" }, idempotencyKey: "ack:om-1" });
    return task;
  });
  const duplicate = tasks.create({ rawInput: "拍 3 条视频", sourceMessageId: "om-1" });
  assert.equal(first.id, duplicate.id);
  assert.equal(db.prepare("SELECT count(*) AS n FROM tasks").get().n, 1);
  assert.equal(db.prepare("SELECT count(*) AS n FROM task_events").get().n, 1);
  assert.equal(db.prepare("SELECT count(*) AS n FROM outbox").get().n, 1);
});

test("updates only allowed task columns", () => {
  const db = openDatabase(":memory:");
  const tasks = createTaskRepository(db, { now: () => NOW, id: () => "task-1" });
  tasks.create({ rawInput: "优化极享 OS", sourceMessageId: "om-2" });
  const updated = tasks.update("task-1", { status: "ready", title: "完成极享 OS 优化", estimateMinutes: 120 });
  assert.equal(updated.status, "ready");
  assert.equal(updated.estimateMinutes, 120);
  assert.throws(() => tasks.update("task-1", { createdAt: "changed" }), /unsupported task field/);
});
```

- [ ] **Step 2: Run the repository tests and verify the missing module failures**

```bash
node --test test/task-repository.test.mjs
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `task-repository.mjs`.

- [ ] **Step 3: Implement the task repository with camelCase row mapping**

`src/db/task-repository.mjs` must normalize defaults, return existing rows for duplicate `sourceMessageId`, and explicitly whitelist update fields. Use this public shape:

```js
import { randomUUID } from "node:crypto";

const ALLOWED = new Map([
  ["title", "title"], ["project", "project"], ["quadrant", "quadrant"], ["importance", "importance"],
  ["urgency", "urgency"], ["dueAt", "due_at"], ["status", "status"], ["nextAction", "next_action"],
  ["doneDefinition", "done_definition"], ["estimateMinutes", "estimate_minutes"], ["blocker", "blocker"],
  ["procrastinationCount", "procrastination_count"], ["analysisStatus", "analysis_status"],
]);

export function createTaskRepository(db, deps = {}) {
  const now = deps.now || (() => new Date().toISOString());
  const id = deps.id || randomUUID;
  const selectById = db.prepare("SELECT * FROM tasks WHERE id = ?");
  const selectByMessage = db.prepare("SELECT * FROM tasks WHERE source_message_id = ?");
  return {
    create(input) {
      if (input.sourceMessageId) {
        const existing = selectByMessage.get(input.sourceMessageId);
        if (existing) return mapTask(existing);
      }
      const timestamp = now();
      const taskId = input.id || id();
      db.prepare(`INSERT INTO tasks
        (id,title,project,raw_input,quadrant,importance,urgency,due_at,status,next_action,done_definition,
         estimate_minutes,blocker,procrastination_count,source_message_id,analysis_status,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        taskId, input.title || input.rawInput.slice(0, 80), input.project || "未归类", input.rawInput,
        input.quadrant || "重要不紧急", input.importance || "B", input.urgency || "medium", input.dueAt || null,
        input.status || "inbox", input.nextAction || "拆出一个 15 分钟动作", input.doneDefinition || "提交明确产出并反馈完成",
        Number(input.estimateMinutes || 30), input.blocker || "", Number(input.procrastinationCount || 0),
        input.sourceMessageId || null, input.analysisStatus || "pending", timestamp, timestamp,
      );
      return mapTask(selectById.get(taskId));
    },
    findById(taskId) { const row = selectById.get(taskId); return row ? mapTask(row) : null; },
    findBySourceMessageId(messageId) { const row = selectByMessage.get(messageId); return row ? mapTask(row) : null; },
    listActive() { return db.prepare("SELECT * FROM tasks WHERE status NOT IN ('done','cancelled') ORDER BY created_at").all().map(mapTask); },
    update(taskId, patch) {
      const entries = Object.entries(patch);
      for (const [key] of entries) if (!ALLOWED.has(key)) throw new Error(`unsupported task field: ${key}`);
      if (!entries.length) return this.findById(taskId);
      const clause = entries.map(([key]) => `${ALLOWED.get(key)} = ?`).join(", ");
      db.prepare(`UPDATE tasks SET ${clause}, updated_at = ? WHERE id = ?`).run(...entries.map(([, value]) => value), now(), taskId);
      return this.findById(taskId);
    },
  };
}

function mapTask(row) {
  return {
    id: row.id, title: row.title, project: row.project, rawInput: row.raw_input, quadrant: row.quadrant,
    importance: row.importance, urgency: row.urgency, dueAt: row.due_at, status: row.status,
    nextAction: row.next_action, doneDefinition: row.done_definition, estimateMinutes: row.estimate_minutes,
    blocker: row.blocker, procrastinationCount: row.procrastination_count, sourceMessageId: row.source_message_id,
    analysisStatus: row.analysis_status, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}
```

- [ ] **Step 4: Implement operations persistence and schedule versioning**

Create `src/db/operations-repository.mjs` with prepared statements and these exact method contracts:

```js
import crypto from "node:crypto";
import { withTransaction } from "./database.mjs";

export function createOperationsRepository(db, deps = {}) {
  const now = deps.now || (() => new Date().toISOString());
  const id = deps.id || (() => crypto.randomUUID());
  return {
    appendEvent({ taskId = null, kind, payload = {}, idempotencyKey = null }) {
      const eventId = id();
      db.prepare(`INSERT OR IGNORE INTO task_events(id,task_id,kind,payload_json,idempotency_key,occurred_at)
        VALUES (?,?,?,?,?,?)`).run(eventId, taskId, kind, JSON.stringify(payload), idempotencyKey, now());
      const row = idempotencyKey
        ? db.prepare("SELECT * FROM task_events WHERE idempotency_key = ?").get(idempotencyKey)
        : db.prepare("SELECT * FROM task_events WHERE id = ?").get(eventId);
      return mapJsonRow(row, "payload_json", "payload");
    },
    listEvents({ taskId = null, date = null } = {}) {
      const clauses = [];
      const values = [];
      if (taskId) { clauses.push("task_id = ?"); values.push(taskId); }
      if (date) { clauses.push("substr(occurred_at, 1, 10) = ?"); values.push(date); }
      const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
      return db.prepare(`SELECT * FROM task_events ${where} ORDER BY occurred_at, id`).all(...values)
        .map((row) => mapJsonRow(row, "payload_json", "payload"));
    },
    replaceSchedule({ date, blocks }) {
      return withTransaction(db, () => {
        const previous = db.prepare("SELECT coalesce(max(version), 0) AS version FROM schedule_blocks WHERE schedule_date = ?").get(date).version;
        const version = previous + 1;
        db.prepare("UPDATE schedule_blocks SET replaced_by_version = ? WHERE schedule_date = ? AND replaced_by_version IS NULL").run(version, date);
        const insert = db.prepare(`INSERT INTO schedule_blocks
          (id,schedule_date,version,task_id,starts_at,ends_at,status,reason,created_at) VALUES (?,?,?,?,?,?,?,?,?)`);
        for (const block of blocks) insert.run(id(), date, version, block.taskId, block.startsAt, block.endsAt, block.status || "planned", block.reason, now());
        return { date, version, blocks: this.currentSchedule(date) };
      });
    },
    currentSchedule(date) {
      return db.prepare(`SELECT * FROM schedule_blocks
        WHERE schedule_date = ? AND replaced_by_version IS NULL ORDER BY starts_at, id`).all(date).map(mapBlock);
    },
    enqueueReminder({ taskId = null, kind, dueAt, expiresAt = null, idempotencyKey }) {
      const reminderId = id();
      db.prepare(`INSERT OR IGNORE INTO reminders
        (id,task_id,kind,due_at,expires_at,status,attempt,idempotency_key,created_at) VALUES (?,?,?,?,?,'pending',0,?,?)`)
        .run(reminderId, taskId, kind, dueAt, expiresAt, idempotencyKey, now());
      return db.prepare("SELECT * FROM reminders WHERE idempotency_key = ?").get(idempotencyKey);
    },
    dueReminders(at) {
      return db.prepare(`SELECT * FROM reminders WHERE status = 'pending' AND due_at <= ?
        AND (expires_at IS NULL OR expires_at > ?) ORDER BY due_at, id`).all(at, at);
    },
    markReminder(idValue, status, firedAt = now()) {
      db.prepare("UPDATE reminders SET status = ?, fired_at = ?, attempt = attempt + 1 WHERE id = ?").run(status, firedAt, idValue);
    },
    enqueueOutbox({ kind, payload, idempotencyKey, nextAttemptAt = now() }) {
      const outboxId = id();
      db.prepare(`INSERT OR IGNORE INTO outbox
        (id,kind,payload_json,idempotency_key,status,attempts,next_attempt_at,created_at)
        VALUES (?,?,?,?,'pending',0,?,?)`).run(outboxId, kind, JSON.stringify(payload), idempotencyKey, nextAttemptAt, now());
      const row = db.prepare("SELECT * FROM outbox WHERE idempotency_key = ?").get(idempotencyKey);
      return mapJsonRow(row, "payload_json", "payload");
    },
    dueOutbox(at, limit = 20) {
      return db.prepare(`SELECT * FROM outbox WHERE status = 'pending' AND next_attempt_at <= ?
        ORDER BY next_attempt_at, id LIMIT ?`).all(at, limit).map((row) => mapJsonRow(row, "payload_json", "payload"));
    },
    markOutboxSent(idValue, externalId = "") {
      db.prepare("UPDATE outbox SET status='sent', external_id=?, sent_at=?, last_error=NULL WHERE id=?").run(externalId, now(), idValue);
    },
    markOutboxRetry(idValue, error, nextAttemptAt) {
      const row = db.prepare("SELECT attempts FROM outbox WHERE id=?").get(idValue);
      const attempts = Number(row?.attempts || 0) + 1;
      const status = attempts >= 8 ? "failed" : "pending";
      db.prepare("UPDATE outbox SET status=?, attempts=?, last_error=?, next_attempt_at=? WHERE id=?")
        .run(status, attempts, String(error.message || error), nextAttemptAt, idValue);
    },
    saveReview({ date, summary, renderedText }) {
      db.prepare(`INSERT INTO daily_reviews(review_date,summary_json,rendered_text,created_at) VALUES (?,?,?,?)
        ON CONFLICT(review_date) DO UPDATE SET summary_json=excluded.summary_json, rendered_text=excluded.rendered_text, created_at=excluded.created_at`)
        .run(date, JSON.stringify(summary), renderedText, now());
      return { date, summary, renderedText };
    },
    getSetting(key) {
      const row = db.prepare("SELECT value_json FROM settings WHERE key=?").get(key);
      return row ? JSON.parse(row.value_json) : null;
    },
    setSetting(key, value) {
      db.prepare(`INSERT INTO settings(key,value_json,updated_at) VALUES (?,?,?)
        ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at`)
        .run(key, JSON.stringify(value), now());
      return value;
    },
  };
}

function mapJsonRow(row, source, target) {
  return { ...row, [target]: JSON.parse(row[source]), [source]: undefined };
}

function mapBlock(row) {
  return {
    id: row.id, date: row.schedule_date, version: row.version, taskId: row.task_id,
    startsAt: row.starts_at, endsAt: row.ends_at, status: row.status, reason: row.reason,
    replacedByVersion: row.replaced_by_version, createdAt: row.created_at,
  };
}
```

Use `INSERT OR IGNORE` for every idempotency key and return the already-existing row after a conflict.

- [ ] **Step 5: Add a one-time Markdown importer without changing SQLite authority**

Add `importMarkdown(kbDir)` to the task repository. It must call the existing `readTasks(kbDir)`, insert each legacy task using its existing ID, map `open` to `ready`, map `doing`, `blocked`, and `done` directly, set `rawInput` to the legacy title, and set `analysisStatus` to `legacy`. A second import must add zero rows.

- [ ] **Step 6: Run repository and legacy tests**

```bash
node --test test/task-repository.test.mjs test/task-store.test.mjs
npm test
```

Expected: all tests PASS.

- [ ] **Step 7: Commit the repository layer**

```bash
git add src/db/task-repository.mjs src/db/operations-repository.mjs src/lib/task-store.mjs test/task-repository.test.mjs
git commit -m "feat: add durable task repositories"
```

---

### Task 3: Schema-Constrained Local Codex Analyzer

**Files:**
- Create: `src/lib/codex-task-schema.json`
- Create: `src/lib/codex-analyzer.mjs`
- Create: `test/codex-analyzer.test.mjs`

**Interfaces:**
- Consumes: config fields `codexBin`, `timezone`
- Produces: `createCodexAnalyzer(config, deps).analyzeTask(input): Promise<TaskAnalysis>`
- Produces: `createCodexAnalyzer(config, deps).minimumAction(input): Promise<{ action: string, minutes: 15 }>`
- Produces: `fallbackTaskAnalysis(rawInput): TaskAnalysis`

- [ ] **Step 1: Write tests for valid JSON, process failure, timeout, and invalid output**

```js
// test/codex-analyzer.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { createCodexAnalyzer } from "../src/lib/codex-analyzer.mjs";

test("returns validated Codex task analysis", async () => {
  const analyzer = createCodexAnalyzer({ timezone: "Asia/Shanghai" }, {
    run: async () => JSON.stringify({
      intent: "create_task", title: "拍摄 3 条口播", project: "个人IP", quadrant: "重要且紧急",
      importance: "A", urgency: "high", dueAt: "2026-07-10T10:00:00.000Z", estimateMinutes: 120,
      nextAction: "打开第一条提纲开始录制", doneDefinition: "3 条可剪辑素材交给剪辑", confidence: 0.93,
    }),
  });
  const result = await analyzer.analyzeTask({ rawInput: "今天拍 3 条口播", now: "2026-07-10T00:30:00.000Z" });
  assert.equal(result.analysisStatus, "complete");
  assert.equal(result.project, "个人IP");
});

test("falls back without losing the original task when Codex fails", async () => {
  const analyzer = createCodexAnalyzer({}, { run: async () => { throw new Error("timeout"); } });
  const result = await analyzer.analyzeTask({ rawInput: "优化极享 OS" });
  assert.equal(result.analysisStatus, "failed");
  assert.equal(result.title, "优化极享 OS");
  assert.equal(result.estimateMinutes, 30);
  assert.match(result.analysisError, /timeout/);
});
```

- [ ] **Step 2: Run tests and verify the missing module failure**

```bash
node --test test/codex-analyzer.test.mjs
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Add a strict JSON Schema**

Create `src/lib/codex-task-schema.json` with `additionalProperties: false`, required fields shown in the valid test, enums for intent/quadrant/importance/urgency, `estimateMinutes` between 5 and 480, and `confidence` between 0 and 1. Permit `dueAt` to be a UTC date-time string or `null`.

- [ ] **Step 4: Implement the Codex process runner and fallback**

`src/lib/codex-analyzer.mjs` must use `spawn` without a shell and pass:

```js
[
  "exec", "--ephemeral", "--sandbox", "read-only",
  "--skip-git-repo-check",
  "--output-schema", schemaPath,
  "--output-last-message", outputPath,
  "--cd", temporaryEmptyDirectory,
  prompt,
]
```

Set a 45-second timeout, kill the child with `SIGTERM`, read the output file, parse JSON, validate every required field again in application code, and delete the temporary directory in `finally`. The prompt must state:

```text
你是个人时间管理系统中的任务分析器。只分析输入，不执行任务、不修改文件、不发送消息。
根据当前时间和 Asia/Shanghai 时区，把用户原话转换为 JSON Schema 要求的结构。
不要编造客户、金额、负责人或硬截止时间。缺少截止时间时返回 null。
下一步必须能在 5-30 分钟内开始，完成标准必须是可观察的产出。
```

Implement fallback values exactly as: title from the first 80 characters, project `未归类`, quadrant `重要不紧急`, importance `B`, urgency `medium`, dueAt `null`, estimateMinutes `30`, nextAction `先做 15 分钟，明确第一个可交付动作`, doneDefinition `提交明确产出并反馈完成`, confidence `0`, analysisStatus `failed`.

Implement `minimumAction({ task, blocker })` through the same runner with a dedicated schema requiring exactly `{ "action": string, "minutes": 15 }`. If that call fails, return `{ action: task.nextAction, minutes: 15 }`.

Pass task facts through the prompt only. Run Codex from a newly created empty temporary directory so it does not inspect the repository, SQLite database, Markdown exports, or `.env`.

- [ ] **Step 5: Run analyzer tests and the full suite**

```bash
node --test test/codex-analyzer.test.mjs
npm test
```

Expected: all tests PASS; tests use injected `run` and do not invoke the real Codex binary.

- [ ] **Step 6: Commit the analyzer**

```bash
git add src/lib/codex-task-schema.json src/lib/codex-analyzer.mjs test/codex-analyzer.test.mjs
git commit -m "feat: add local codex task analyzer"
```

---

### Task 4: Deterministic Daily Schedule Engine

**Files:**
- Create: `src/lib/schedule-engine.mjs`
- Create: `test/schedule-engine.test.mjs`
- Modify: `src/lib/prioritizer.mjs`

**Interfaces:**
- Consumes: active task objects from `task-repository`
- Produces: `buildDailySchedule({ date, now, tasks, settings }): { date, blocks, deferred, reasons }`
- Produces: `replanRemaining({ schedule, now, tasks, settings }): ScheduleResult`
- Produces block shape `{ taskId, startsAt, endsAt, reason }`

- [ ] **Step 1: Write failing tests for task limit, capacity, priority override, and replanning**

```js
// test/schedule-engine.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { buildDailySchedule, replanRemaining } from "../src/lib/schedule-engine.mjs";

const settings = {
  timezone: "Asia/Shanghai",
  windows: [["10:00", "12:00"], ["14:00", "18:00"], ["20:00", "22:00"]],
  maxCriticalTasks: 3,
  projectBoosts: [{ project: "个人IP", points: 100, startsOn: "2026-07-10", endsOn: "2026-07-15" }],
};

test("schedules at most three tasks inside available windows", () => {
  const tasks = Array.from({ length: 5 }, (_, i) => ({
    id: `t${i}`, title: `任务${i}`, project: "极享OS", importance: i === 0 ? "S" : "A",
    urgency: "high", quadrant: "重要且紧急", estimateMinutes: 120, status: "ready", procrastinationCount: 0,
  }));
  const result = buildDailySchedule({ date: "2026-07-10", now: "2026-07-10T00:30:00.000Z", tasks, settings });
  assert.equal(result.blocks.length, 3);
  assert.ok(result.blocks.every((block) => block.startsAt < block.endsAt));
  assert.equal(result.deferred.length, 2);
});

test("applies the dated personal-IP boost and preserves a doing block during replan", () => {
  const tasks = [
    { id: "ip", title: "拍视频", project: "个人IP", importance: "A", urgency: "medium", quadrant: "重要不紧急", estimateMinutes: 120, status: "ready", procrastinationCount: 0 },
    { id: "os", title: "优化系统", project: "极享OS", importance: "A", urgency: "high", quadrant: "重要且紧急", estimateMinutes: 240, status: "ready", procrastinationCount: 0 },
  ];
  const first = buildDailySchedule({ date: "2026-07-10", now: "2026-07-10T00:30:00.000Z", tasks, settings });
  assert.equal(first.blocks[0].taskId, "ip");
  const current = { ...first.blocks[0], status: "doing" };
  const replanned = replanRemaining({ schedule: { ...first, blocks: [current, ...first.blocks.slice(1)] }, now: current.startsAt, tasks, settings });
  assert.equal(replanned.blocks[0].taskId, "ip");
});
```

- [ ] **Step 2: Run tests and verify the missing module failure**

```bash
node --test test/schedule-engine.test.mjs
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Extract a pure score function and implement time-block allocation**

Retain existing score weights in `prioritizer.mjs`, add dated project boosts, and export `scoreTask`. In `schedule-engine.mjs`:

1. Convert each `HH:mm` window into UTC instants using the configured timezone.
2. Exclude `done`, `cancelled`, and already-expired schedule blocks.
3. Sort by deterministic score, then due date, then creation time, then task ID.
4. Pick at most `maxCriticalTasks` distinct tasks.
5. Allocate contiguous minutes across windows without overlap.
6. If one task exceeds a window, split it into multiple blocks with the same task ID.
7. Preserve the current `doing` block during `replanRemaining` and only replace blocks that have not started.
8. Return a reason string naming the top two score factors for each selected task.

Use no random values and accept all time through function arguments so tests can control time.

- [ ] **Step 4: Run schedule and prioritizer tests**

```bash
node --test test/schedule-engine.test.mjs test/prioritizer.test.mjs
npm test
```

Expected: all tests PASS.

- [ ] **Step 5: Commit the schedule engine**

```bash
git add src/lib/schedule-engine.mjs src/lib/prioritizer.mjs test/schedule-engine.test.mjs test/prioritizer.test.mjs
git commit -m "feat: add deterministic daily scheduling"
```

---

### Task 5: Task State Machine, Durable Reminders, and Recovery

**Files:**
- Create: `src/lib/task-state-machine.mjs`
- Create: `src/lib/reminder-engine.mjs`
- Create: `src/lib/recovery.mjs`
- Create: `test/task-state-machine.test.mjs`
- Create: `test/reminder-engine.test.mjs`
- Create: `test/recovery.test.mjs`

**Interfaces:**
- Consumes: task and operations repositories
- Produces: `transitionTask({ task, action, detail, at }): { patch, event }`
- Produces: `createReminderEngine({ tasks, ops, analyzer, replan, clock })`
- Produces: `recoverManagerState({ now, date, tasks, ops, replan })`

- [ ] **Step 1: Write state transition tests**

Test these exact transitions:

```js
assert.equal(transitionTask({ task: ready, action: "start", at: NOW }).patch.status, "doing");
assert.equal(transitionTask({ task: doing, action: "complete", at: NOW }).patch.status, "done");
assert.equal(transitionTask({ task: doing, action: "block", detail: "不知道怎么开头", at: NOW }).patch.status, "blocked");
assert.equal(transitionTask({ task: ready, action: "defer", at: NOW }).patch.status, "deferred");
assert.equal(transitionTask({ task: done, action: "restore", at: NOW }).patch.status, "ready");
assert.throws(() => transitionTask({ task: done, action: "start", at: NOW }), /illegal transition/);
```

The block transition must preserve the original task, set `blocker`, and not increment procrastination count. The second no-response action increments procrastination count exactly once.

- [ ] **Step 2: Write reminder and recovery tests with a fake clock**

The reminder test must create `task_start`, `no_response_1`, and `no_response_2` rows, then advance a fake clock. Assert that the second no-response event:

- increments `procrastinationCount` from 0 to 1;
- asks the analyzer for one 15-minute action;
- emits one intervention outbox row;
- calls `replan` once;
- does not enqueue a third repeating no-response reminder.

The recovery test must seed three reminders: one expired, one currently actionable, and one future. Assert that recovery marks the expired row `expired`, leaves the future row pending, invalidates the old plan-start reminder, calls `replan`, and enqueues exactly one `recovery_plan` card.

- [ ] **Step 3: Run tests and verify missing modules**

```bash
node --test test/task-state-machine.test.mjs test/reminder-engine.test.mjs test/recovery.test.mjs
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 4: Implement legal transitions and reminder processing**

Use an explicit transition table:

```js
const LEGAL = {
  inbox: new Set(["ready", "cancelled"]),
  ready: new Set(["scheduled", "doing", "deferred", "cancelled"]),
  scheduled: new Set(["doing", "blocked", "deferred", "cancelled"]),
  doing: new Set(["done", "blocked", "deferred", "cancelled"]),
  blocked: new Set(["doing", "deferred", "cancelled"]),
  deferred: new Set(["ready", "scheduled", "doing", "cancelled"]),
  done: new Set(["ready"]),
  cancelled: new Set([]),
};
```

Map user actions to target states and event kinds. Keep `no_response_2` as an event that patches `procrastinationCount` while leaving the task scheduled or doing.

Only the explicit `restore` action may move `done` to `ready`; no scheduler or recovery path may reopen a completed task.

The reminder engine must process due rows in due-time order inside short transactions. Claim a reminder by setting it to `processing`; after business work succeeds set `fired`, and after an exception return it to `pending` with a future due time and incremented attempt.

- [ ] **Step 5: Implement restart and wake recovery**

`recoverManagerState` must compare `expiresAt` to `now`, invalidate stale reminders, find any task left `doing`, retain that task as current focus, and invoke `replan` for all future blocks. It must enqueue one recovery card with idempotency key `recovery:<date>:<schedule-version>`.

- [ ] **Step 6: Run state, reminder, recovery, and full tests**

```bash
node --test test/task-state-machine.test.mjs test/reminder-engine.test.mjs test/recovery.test.mjs
npm test
```

Expected: all tests PASS.

- [ ] **Step 7: Commit the management rules**

```bash
git add src/lib/task-state-machine.mjs src/lib/reminder-engine.mjs src/lib/recovery.mjs test/task-state-machine.test.mjs test/reminder-engine.test.mjs test/recovery.test.mjs
git commit -m "feat: add reminder escalation and recovery"
```

---

### Task 6: Feishu Cards, Text/Card Event Normalization, and Outbox Delivery

**Files:**
- Create: `src/lib/feishu-cards.mjs`
- Create: `src/lib/feishu-messages.mjs`
- Create: `src/lib/outbox-worker.mjs`
- Create: `test/feishu-cards.test.mjs`
- Create: `test/outbox-worker.test.mjs`
- Modify: `src/lib/feishu-events.mjs`
- Modify: `src/lib/feishu-openapi.mjs`
- Modify: `src/lib/feishu-tasks.mjs`
- Modify: `test/feishu-tasks.test.mjs`

**Interfaces:**
- Consumes: outbox operations repository
- Produces: card renderers `renderDailyPlanCard`, `renderCurrentTaskCard`, `renderInterventionCard`, `renderReviewCard`
- Produces: `normalizeManagerAction(input): { action, taskId, detail, idempotencyKey } | null`
- Produces: `sendFeishuMessage(config, payload): Promise<{ externalId }>`
- Produces: `syncFeishuTask(config, operation): Promise<{ externalId }>`
- Produces: `createOutboxWorker({ ops, send, clock }).flush(): Promise<number>`

- [ ] **Step 1: Write card and normalization tests**

Assert that the current-task card contains four actions with values `start`, `complete`, `block`, and `defer_30`, and every button includes the task ID. Assert these pairs normalize identically:

```text
button start + task-1        == "开始：拍视频"
button complete + task-1     == "完成：拍视频"
button block + detail        == "卡住：拍视频 不知道怎么开头"
button defer_30 + task-1     == "推迟30分钟：拍视频"
text restore                 == "恢复：拍视频"
```

Use the task repository for text title matching and reject ambiguous partial matches with a response asking the user to choose one task.

- [ ] **Step 2: Write outbox retry tests**

Inject a sender that fails twice and succeeds the third time. Assert retry times are `now + 30 seconds`, then `now + 120 seconds`; the third result marks the row sent and stores the returned Feishu message ID. After 8 attempts mark the row `failed` and enqueue no duplicate business message.

- [ ] **Step 3: Run tests and verify missing modules**

```bash
node --test test/feishu-cards.test.mjs test/outbox-worker.test.mjs
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 4: Implement Feishu card rendering**

Use Feishu interactive card JSON with a stable `schema: "2.0"`. Keep business text in renderer inputs, not hard-coded to a specific date. Buttons must include:

```js
{
  tag: "button",
  text: { tag: "plain_text", content: "▶ 开始" },
  type: "primary",
  value: { action: "start", taskId: task.id },
}
```

Render only one current task per task card. Daily plan cards may list 1–3 tasks. Every replan card must show `changed` and `reason` sections.

- [ ] **Step 5: Implement OpenAPI sending and event normalization**

Send messages through the app OpenAPI so cards can be addressed to the configured user or chat. Add a generic POST helper to `feishu-openapi.mjs`, then call `/im/v1/messages?receive_id_type=<type>` with `msg_type` of `interactive` or `text`. Parse the returned message ID.

Keep `extractMessageText` in `feishu-events.mjs`. Add card action extraction for the Feishu card-action event shape and normalize text/card actions into the same action object before calling business logic.

Use the existing `feishu-tasks.mjs` functions for formal task creation. Add update support for summary, description, due date, and completion state. Represent formal-task work as outbox kinds `feishu_task_create` and `feishu_task_update`; store the returned task GUID in a `feishu_task_guid` setting keyed by local task ID. A local completion must enqueue one update operation, and a retry must reuse the same local-task idempotency key.

- [ ] **Step 6: Implement bounded outbox retries**

Process at most 20 due rows per flush, one row at a time. Use retry delays in seconds `[30, 120, 300, 900, 1800, 3600, 7200]`; after the eighth failed attempt mark the row failed and write an error event that excludes secrets and full payload contents.

- [ ] **Step 7: Run Feishu, outbox, and existing event tests**

```bash
node --test test/feishu-cards.test.mjs test/outbox-worker.test.mjs test/feishu-events.test.mjs test/feishu-tasks.test.mjs
npm test
```

Expected: all tests PASS.

- [ ] **Step 8: Commit Feishu interaction support**

```bash
git add src/lib/feishu-cards.mjs src/lib/feishu-messages.mjs src/lib/outbox-worker.mjs src/lib/feishu-events.mjs src/lib/feishu-openapi.mjs src/lib/feishu-tasks.mjs test/feishu-cards.test.mjs test/outbox-worker.test.mjs test/feishu-events.test.mjs test/feishu-tasks.test.mjs
git commit -m "feat: add durable feishu card interactions"
```

---

### Task 7: Manager Service and Automatic Replanning

**Files:**
- Create: `src/lib/manager-service.mjs`
- Create: `test/manager-service.test.mjs`
- Modify: `src/lib/dispatch.mjs`
- Modify: `src/lib/feishu-events.mjs`

**Interfaces:**
- Consumes: task repository, operations repository, analyzer, schedule engine, state machine, card renderers
- Produces: `createManagerService(deps)` with methods `ingest`, `handleAction`, `dispatchDay`, `replanDay`, `runMiddayCheck`, `runDayClose`

- [ ] **Step 1: Write an end-to-end service test for natural-language intake**

Given message ID `om-100` and text `今天拍 3 条 Codex 口播`, assert:

1. one inbox task is stored before analysis;
2. analyzer output updates it to `ready`;
3. one `task_created` and one `task_analyzed` event exist;
4. one acknowledgement is enqueued;
5. replaying `om-100` returns the same task and adds no event or outbox row.

- [ ] **Step 2: Write service tests for complete, block, defer, and two-response ambiguity**

Assert that every valid action changes status, appends one event, recalculates future blocks, invalidates replaced reminders, and enqueues a card explaining the change. For two active tasks containing the same partial title, text feedback must not change either task and must enqueue a disambiguation card.

Add a concurrency case with one `doing` task and a second `start` action. Assert that the service returns a card asking whether to complete, block, or defer the current task and does not start the second task. After the first task leaves `doing`, starting the second task succeeds.

- [ ] **Step 3: Run the service tests and verify the missing module failure**

```bash
node --test test/manager-service.test.mjs
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 4: Implement transactional intake**

`ingest({ messageId, text, chatId, senderId })` must:

1. reject messages from a different configured user when `managerUserId` is set;
2. return an existing task for duplicate `messageId`;
3. create the inbox task and acknowledgement outbox row in one transaction;
4. run Codex after the transaction;
5. update analyzed fields and append `task_analyzed` in a second transaction;
6. call `replanDay` if the task is due today or marked urgent.

- [ ] **Step 5: Implement unified actions and replanning**

`handleAction` must use `normalizeManagerAction`, resolve exactly one task, call `transitionTask`, persist the patch and event transactionally, then replan only future blocks. A completed task must cancel its pending reminders. A blocked task must request a 15-minute minimum action and enqueue an intervention card.

Before a `start` transition, query for an existing `doing` task. Reject the new start while a different task is active. Support explicit text `恢复：任务名` as the only path from `done` back to `ready`.

`dispatchDay` must replace the current schedule, enqueue one daily-plan card, and create start reminders plus the two no-response reminder rows for each selected task. `runMiddayCheck` and `runDayClose` must call the same replan path with reason codes `midday_check` and `day_close`.

- [ ] **Step 6: Redirect current dispatch and inbound handlers through the service**

Keep the exported current functions for compatibility, but make production dependency composition call manager service methods. Existing command tests must continue to pass using their injected legacy dependencies until the final daemon switches fully to the manager service.

- [ ] **Step 7: Run manager, dispatch, event, and full tests**

```bash
node --test test/manager-service.test.mjs test/feishu-events.test.mjs test/ingest.test.mjs
npm test
```

Expected: all tests PASS.

- [ ] **Step 8: Commit the manager service**

```bash
git add src/lib/manager-service.mjs src/lib/dispatch.mjs src/lib/feishu-events.mjs test/manager-service.test.mjs
git commit -m "feat: orchestrate automatic task management"
```

---

### Task 8: Daily Review, Markdown Projection, and Accelerated End-to-End Day

**Files:**
- Create: `src/lib/daily-review.mjs`
- Create: `src/lib/markdown-export.mjs`
- Create: `test/daily-review.test.mjs`
- Create: `test/manager-e2e.test.mjs`
- Modify: `src/lib/daily-plan.mjs`

**Interfaces:**
- Consumes: tasks, schedule blocks, task events, analyzer
- Produces: `buildDailyReview({ date, tasks, schedule, events }): ReviewSummary`
- Produces: `renderDailyReview(summary): string`
- Produces: `exportDay({ exportDir, date, schedule, review }): Promise<{ planFile, reviewFile }>`

- [ ] **Step 1: Write deterministic daily-review tests**

Seed three critical tasks: two done and one deferred, plus one procrastination event and one replan event. Assert summary values:

```js
{
  criticalPlanned: 3,
  criticalCompleted: 2,
  completionRate: 67,
  procrastinationCount: 1,
  blockedCount: 0,
  deferredTitles: ["极享 OS 测试收尾"],
  tomorrowCandidates: ["极享 OS 测试收尾"],
}
```

Assert rendered text names the changed plan and reason without inventing emotional judgments.

- [ ] **Step 2: Write an accelerated-day integration test**

Use an injected fake clock and map the daily cadence to seconds: plan at second 0, task start at 1, first no-response at 2, second at 3, midday at 4, day close at 5, review at 6. Assert the event sequence:

```text
daily_plan_created
task_start_reminded
no_response_1
procrastination_recorded
schedule_replanned
midday_checked
day_closed
daily_review_created
```

Assert the outbox contains one plan, one start reminder, one first chase, one intervention, one replan, and one review card.

- [ ] **Step 3: Run tests and verify missing modules**

```bash
node --test test/daily-review.test.mjs test/manager-e2e.test.mjs
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 4: Implement factual review generation**

Calculate metrics entirely from database facts. Codex may rewrite a short recommendation only after deterministic summary fields exist. If Codex fails, use:

```text
明天先继续最高优先级的未完成任务；开始前只看下一步动作，不重新整理全部计划。
```

Persist both summary JSON and rendered text before enqueueing the review card.

- [ ] **Step 5: Implement one-way Markdown exports**

Write `exports/YYYY-MM-DD-plan.md` and `exports/YYYY-MM-DD-review.md` atomically through a temporary file and rename. Never read those files to mutate SQLite. Update `daily-plan.mjs` to reuse render helpers while keeping existing public functions and tests.

- [ ] **Step 6: Run review, E2E, daily-plan, and full tests**

```bash
node --test test/daily-review.test.mjs test/manager-e2e.test.mjs test/task-store.test.mjs
npm test
```

Expected: all tests PASS.

- [ ] **Step 7: Commit the review loop**

```bash
git add src/lib/daily-review.mjs src/lib/markdown-export.mjs src/lib/daily-plan.mjs test/daily-review.test.mjs test/manager-e2e.test.mjs
git commit -m "feat: add evening review and markdown export"
```

---

### Task 9: Verified SQLite Backup and Seven-Day Retention

**Files:**
- Create: `src/db/backup.mjs`
- Create: `test/backup.test.mjs`

**Interfaces:**
- Consumes: an open `DatabaseSync` and config field `backupDir`
- Produces: `backupDatabase({ db, backupDir, now }): Promise<string>`
- Produces: `pruneBackups({ backupDir, keep: 7 }): Promise<string[]>`

- [ ] **Step 1: Write the failing backup and retention test**

```js
// test/backup.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { openDatabase } from "../src/db/database.mjs";
import { backupDatabase } from "../src/db/backup.mjs";

test("creates a readable backup and retains only the newest seven", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "time-manager-backup-"));
  const source = path.join(dir, "manager.sqlite");
  const backupDir = path.join(dir, "backups");
  const db = openDatabase(source);
  db.prepare("INSERT INTO settings(key,value_json,updated_at) VALUES (?,?,?)").run("probe", "true", "2026-07-01T00:00:00.000Z");
  for (let day = 1; day <= 9; day += 1) {
    await backupDatabase({ db, backupDir, now: new Date(`2026-07-${String(day).padStart(2, "0")}T14:00:00.000Z`) });
  }
  const files = (await fs.readdir(backupDir)).filter((name) => name.endsWith(".sqlite")).sort();
  assert.equal(files.length, 7);
  assert.match(files[0], /2026-07-03/);
  const restored = openDatabase(path.join(backupDir, files.at(-1)));
  assert.equal(restored.prepare("SELECT value_json FROM settings WHERE key='probe'").get().value_json, "true");
  restored.close();
  db.close();
});
```

- [ ] **Step 2: Run the test and verify the missing module failure**

```bash
node --test test/backup.test.mjs
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement backup and retention with the built-in SQLite backup API**

```js
// src/db/backup.mjs
import fs from "node:fs/promises";
import path from "node:path";
import { backup } from "node:sqlite";

export async function backupDatabase({ db, backupDir, now = new Date() }) {
  await fs.mkdir(backupDir, { recursive: true });
  const stamp = now.toISOString().replace(/[:]/g, "-");
  const file = path.join(backupDir, `time-manager-${stamp}.sqlite`);
  await backup(db, file);
  await pruneBackups({ backupDir, keep: 7 });
  return file;
}

export async function pruneBackups({ backupDir, keep = 7 }) {
  const names = (await fs.readdir(backupDir)).filter((name) => /^time-manager-.*\.sqlite$/.test(name)).sort().reverse();
  const removed = [];
  for (const name of names.slice(keep)) {
    await fs.unlink(path.join(backupDir, name));
    removed.push(name);
  }
  return removed;
}
```

- [ ] **Step 4: Run the backup and database tests**

```bash
node --test test/backup.test.mjs test/database.test.mjs
```

Expected: both tests PASS.

- [ ] **Step 5: Commit backup support**

```bash
git add src/db/backup.mjs test/backup.test.mjs
git commit -m "feat: add verified sqlite backups"
```

---

### Task 10: Production Daemon, Feishu Listener Composition, and launchd

**Files:**
- Create: `src/manager-app.mjs`
- Create: `scripts/run-manager.mjs`
- Create: `scripts/install-launchd.mjs`
- Create: `scripts/uninstall-launchd.mjs`
- Create: `test/launchd.test.mjs`
- Modify: `scripts/feishu-listen.mjs`
- Modify: `README.md`
- Modify: `docs/feishu-setup.md`

**Interfaces:**
- Consumes: all earlier production modules
- Produces: `createManagerApp(config, deps).start(): Promise<void>` and `.stop(): Promise<void>`
- Produces: LaunchAgent label `com.nge.time-management-master`

- [ ] **Step 1: Write a launchd plist rendering test**

Assert generated XML contains:

- label `com.nge.time-management-master`;
- absolute `process.execPath`;
- absolute `scripts/run-manager.mjs` path;
- project root as `WorkingDirectory`;
- `RunAtLoad` and `KeepAlive` set true;
- stdout/stderr paths under the configured data directory;
- no Feishu secret values embedded in the plist.

- [ ] **Step 2: Run the test and verify the missing module failure**

```bash
node --test test/launchd.test.mjs
```

Expected: FAIL because `install-launchd.mjs` does not export `renderLaunchAgentPlist`.

- [ ] **Step 3: Compose the manager app**

`createManagerApp` must:

1. open SQLite and run migration;
2. create repositories and services;
3. run recovery before accepting new messages;
4. start the Feishu WebSocket dispatcher for `im.message.receive_v1` and the card-action event;
5. start a 30-second durable reminder poll and a 10-second outbox poll;
6. schedule fixed daily reminder rows for plan, midday, close, and review seven days ahead;
7. schedule one verified SQLite backup after the evening review and retain seven backups;
8. seed `settings` from config only when a setting has no stored value, so later user changes survive restart;
9. trap `SIGINT` and `SIGTERM`, stop timers and WebSocket, flush no new work, and close SQLite.

Use unref-free timers so the daemon stays alive. Log only event IDs, task IDs, statuses, and errors with secrets removed.

- [ ] **Step 4: Implement entry point and preserve the manual listener command**

`scripts/run-manager.mjs` loads config, validates required app credentials and user/chat destination, starts the app, and sets `process.exitCode = 1` on fatal startup error. Change `scripts/feishu-listen.mjs` to print a deprecation notice and call the same manager app so there is only one production listener implementation.

- [ ] **Step 5: Implement safe launchd install and uninstall scripts**

The installer must create `~/Library/LaunchAgents/com.nge.time-management-master.plist`, then run:

```bash
launchctl bootout gui/$UID ~/Library/LaunchAgents/com.nge.time-management-master.plist
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.nge.time-management-master.plist
launchctl kickstart -k gui/$UID/com.nge.time-management-master
```

Ignore only the bootout error that means the service was not loaded. The uninstaller bootouts the service and removes only that exact plist file. Neither script edits `.env`.

- [ ] **Step 6: Document exact setup and verification commands**

Update README and Feishu setup docs with:

```bash
npm test
npm run manager
npm run manager:install
launchctl print gui/$UID/com.nge.time-management-master
tail -f data/logs/manager.stdout.log data/logs/manager.stderr.log
npm run manager:uninstall
```

Document required Feishu message/card events and permissions, `CODEX_BIN`, database path, work-time variables, Mac sleep limitation, and the rule that local SQLite is authoritative.

- [ ] **Step 7: Run all automated verification**

```bash
npm test
node --test test/manager-e2e.test.mjs test/launchd.test.mjs
git diff --check
```

Expected: all tests PASS and `git diff --check` prints no output.

- [ ] **Step 8: Run one real local smoke test without installing launchd**

Create a test `.env` with the existing Feishu credentials and explicit `TIME_MASTER_DATA_DIR`. Run:

```bash
npm run manager
```

Expected log sequence: database opened, recovery completed, Feishu WebSocket connected, reminder worker started, outbox worker started. In Feishu send `新增：今天拍 3 条 Codex 口播`; expect one acknowledgement and one task row. Send `今日任务`; expect one daily plan card. Stop with Ctrl-C and expect a clean shutdown message.

- [ ] **Step 9: Commit production operation support**

```bash
git add src/manager-app.mjs scripts/run-manager.mjs scripts/feishu-listen.mjs scripts/install-launchd.mjs scripts/uninstall-launchd.mjs test/launchd.test.mjs README.md docs/feishu-setup.md package.json package-lock.json
git commit -m "feat: run time manager as mac service"
```

---

## Final Verification Gate

- [ ] Run `npm test` and record the passing test count.
- [ ] Run the accelerated-day test independently and confirm the full event sequence.
- [ ] Start the manager, verify Feishu text intake, card action, plan dispatch, block handling, and completion handling.
- [ ] Restart the manager while one task is active and confirm exactly one recovery plan is sent.
- [ ] Temporarily point `CODEX_BIN` to an invalid path and confirm task intake falls back without data loss.
- [ ] Temporarily disable network access and confirm outbox rows retry and later send once.
- [ ] Install the LaunchAgent, verify `launchctl print`, reboot or log out/in, and confirm automatic restart.
- [ ] Confirm `.env`, SQLite files, logs, and `.superpowers/` are not tracked by Git.
- [ ] Review `git log --oneline` and ensure each task has its own focused commit.
