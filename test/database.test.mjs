import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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
