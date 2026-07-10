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
  db.prepare("INSERT INTO settings(key,value_json,updated_at) VALUES (?,?,?)")
    .run("probe", "true", "2026-07-01T00:00:00.000Z");

  for (let day = 1; day <= 9; day += 1) {
    await backupDatabase({
      db,
      backupDir,
      now: new Date(`2026-07-${String(day).padStart(2, "0")}T14:00:00.000Z`),
    });
  }

  const files = (await fs.readdir(backupDir))
    .filter((name) => name.endsWith(".sqlite"))
    .sort();
  assert.equal(files.length, 7);
  assert.match(files[0], /2026-07-03/);
  const restored = openDatabase(path.join(backupDir, files.at(-1)));
  assert.equal(
    restored.prepare("SELECT value_json FROM settings WHERE key='probe'").get().value_json,
    "true",
  );
  restored.close();
  db.close();
});
