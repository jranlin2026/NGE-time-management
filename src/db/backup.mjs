import fs from "node:fs/promises";
import path from "node:path";
import { backup } from "node:sqlite";

export async function backupDatabase({ db, backupDir, now = new Date() }) {
  await fs.mkdir(backupDir, { recursive: true });
  const stamp = now.toISOString().replace(/:/g, "-");
  const file = path.join(backupDir, `time-manager-${stamp}.sqlite`);
  await backup(db, file);
  await pruneBackups({ backupDir, keep: 7 });
  return file;
}

export async function pruneBackups({ backupDir, keep = 7 }) {
  const names = (await fs.readdir(backupDir))
    .filter((name) => /^time-manager-.*\.sqlite$/.test(name))
    .sort()
    .reverse();
  const removed = [];
  for (const name of names.slice(keep)) {
    await fs.unlink(path.join(backupDir, name));
    removed.push(name);
  }
  return removed;
}
