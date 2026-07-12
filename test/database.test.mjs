import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openDatabase, withTransaction } from "../src/db/database.mjs";

test("opens a WAL database and creates all version-one tables", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "time-manager-db-"));
  const db = openDatabase(path.join(dir, "manager.sqlite"));
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all()
    .map((row) => row.name);

  assert.equal(db.prepare("PRAGMA journal_mode").get().journal_mode, "wal");
  for (const name of [
    "schema_migrations",
    "tasks",
    "task_events",
    "schedule_blocks",
    "reminders",
    "outbox",
    "daily_reviews",
    "settings",
  ]) {
    assert.ok(tables.includes(name), `missing table ${name}`);
  }
  db.close();
});

test("rolls back a failed transaction", () => {
  const db = openDatabase(":memory:");
  assert.throws(() => {
    withTransaction(db, () => {
      db.prepare("INSERT INTO settings(key, value_json, updated_at) VALUES (?, ?, ?)").run(
        "probe",
        "true",
        new Date().toISOString(),
      );
      throw new Error("stop");
    });
  });
  assert.equal(db.prepare("SELECT count(*) AS count FROM settings").get().count, 0);
  db.close();
});

test("migration three adds project execution tables and task columns", () => {
  const db = openDatabase(":memory:");
  const columns = db.prepare("PRAGMA table_info(tasks)").all().map((row) => row.name);

  for (const name of ["project_id", "milestone_id", "deliverable_id", "requires_evidence", "impact"]) {
    assert.ok(columns.includes(name), `missing task column ${name}`);
  }
  for (const table of ["weekly_plans", "task_acceptances", "project_sync_state"]) {
    assert.ok(
      db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table),
      `missing table ${table}`,
    );
  }
  assert.ok(db.prepare("SELECT 1 FROM schema_migrations WHERE version = 3").get());
  db.close();
});

test("upgrades a version-two database without losing tasks and applies new defaults", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "time-manager-v2-"));
  const file = path.join(dir, "manager.sqlite");
  const legacy = new DatabaseSync(file);
  legacy.exec(`
    CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
    INSERT INTO schema_migrations VALUES (1, '2026-07-01T00:00:00.000Z'), (2, '2026-07-02T00:00:00.000Z');
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, project TEXT NOT NULL DEFAULT '未归类', raw_input TEXT NOT NULL,
      quadrant TEXT NOT NULL DEFAULT '重要不紧急', importance TEXT NOT NULL DEFAULT 'B', urgency TEXT NOT NULL DEFAULT 'medium',
      due_at TEXT, status TEXT NOT NULL DEFAULT 'inbox', next_action TEXT NOT NULL, done_definition TEXT NOT NULL,
      estimate_minutes INTEGER NOT NULL DEFAULT 30, blocker TEXT NOT NULL DEFAULT '', procrastination_count INTEGER NOT NULL DEFAULT 0,
      source_message_id TEXT UNIQUE, analysis_status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL, checkpoints_json TEXT NOT NULL DEFAULT '[]'
    );
    INSERT INTO tasks
      (id,title,project,raw_input,next_action,done_definition,created_at,updated_at)
      VALUES ('legacy-task','保留旧任务','个人IP','旧输入','下一步','完成定义','2026-07-01','2026-07-02');
  `);
  legacy.close();

  const db = openDatabase(file);
  const task = db.prepare("SELECT * FROM tasks WHERE id = 'legacy-task'").get();
  assert.equal(task.title, "保留旧任务");
  assert.equal(task.raw_input, "旧输入");
  assert.equal(task.project_id, null);
  assert.equal(task.milestone_id, null);
  assert.equal(task.deliverable_id, null);
  assert.equal(task.requires_evidence, 0);
  assert.equal(task.impact, "normal");
  assert.ok(db.prepare("SELECT 1 FROM schema_migrations WHERE version = 3").get());
  db.close();
});

test("migration four adds automation runtime tables and indexes", () => {
  const db = openDatabase(":memory:");
  const runColumns = db.prepare("PRAGMA table_info(automation_runs)").all().map((row) => row.name);
  for (const table of [
    "automation_runs",
    "automation_locks",
    "inbound_messages",
    "message_cursors",
    "feishu_task_links",
  ]) {
    assert.ok(
      db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table),
      `missing table ${table}`,
    );
  }
  assert.ok(runColumns.includes("claim_token"), "missing automation run fencing token");
  assert.ok(db.prepare("SELECT 1 FROM schema_migrations WHERE version = 4").get());
  db.close();
});
