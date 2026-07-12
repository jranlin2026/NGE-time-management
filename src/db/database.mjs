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

const MIGRATION_2 = `
ALTER TABLE tasks ADD COLUMN checkpoints_json TEXT NOT NULL DEFAULT '[]';
`;

const MIGRATION_3 = `
ALTER TABLE tasks ADD COLUMN project_id TEXT;
ALTER TABLE tasks ADD COLUMN milestone_id TEXT;
ALTER TABLE tasks ADD COLUMN deliverable_id TEXT;
ALTER TABLE tasks ADD COLUMN requires_evidence INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN impact TEXT NOT NULL DEFAULT 'normal';
CREATE TABLE weekly_plans (
  week_id TEXT NOT NULL, version INTEGER NOT NULL, markdown_path TEXT NOT NULL,
  content_hash TEXT NOT NULL, status TEXT NOT NULL, plan_json TEXT NOT NULL,
  created_at TEXT NOT NULL, confirmed_at TEXT, confirmation_event_id TEXT UNIQUE,
  PRIMARY KEY(week_id, version)
);
CREATE TABLE task_acceptances (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL, deliverable_id TEXT NOT NULL,
  evidence_json TEXT NOT NULL, status TEXT NOT NULL, explanation TEXT NOT NULL,
  idempotency_key TEXT UNIQUE, created_at TEXT NOT NULL, decided_at TEXT,
  FOREIGN KEY(task_id) REFERENCES tasks(id)
);
CREATE TABLE project_sync_state (
  project_id TEXT PRIMARY KEY, file_path TEXT NOT NULL, content_hash TEXT NOT NULL,
  last_written_version INTEGER NOT NULL DEFAULT 0, last_error TEXT, updated_at TEXT NOT NULL
);
`;

const MIGRATION_4 = `
CREATE TABLE automation_runs (
  run_key TEXT PRIMARY KEY, work_date TEXT NOT NULL, node TEXT NOT NULL,
  status TEXT NOT NULL, started_at TEXT NOT NULL, expires_at TEXT NOT NULL, claim_token TEXT NOT NULL,
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

const MIGRATION_5 = `
ALTER TABLE automation_runs ADD COLUMN analysis_json TEXT;
`;

const MIGRATION_6 = `
ALTER TABLE schedule_blocks ADD COLUMN checkpoint_index INTEGER;
CREATE INDEX idx_blocks_checkpoint ON schedule_blocks(schedule_date, task_id, checkpoint_index);
`;

export function openDatabase(filePath) {
  if (filePath !== ":memory:") fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const db = new DatabaseSync(filePath);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  const migrations = [MIGRATION_1, MIGRATION_2, MIGRATION_3, MIGRATION_4, MIGRATION_5, MIGRATION_6];
  for (let index = 0; index < migrations.length; index += 1) {
    const version = index + 1;
    const hasMigrations = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
      .get();
    const migrated = hasMigrations
      ? db.prepare("SELECT 1 FROM schema_migrations WHERE version = ?").get(version)
      : null;
    if (migrated) continue;
    withTransaction(db, () => {
      db.exec(migrations[index]);
      db.prepare("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, ?)")
        .run(version, new Date().toISOString());
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
