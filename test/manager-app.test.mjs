import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createManagerApp } from "../src/manager-app.mjs";

test("starts locally, seeds seven days of fixed reminders, recovers, and stops cleanly", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "time-manager-app-"));
  const intervals = [];
  const app = createManagerApp(
    {
      dbPath: path.join(dir, "manager.sqlite"),
      dataDir: dir,
      backupDir: path.join(dir, "backups"),
      markdownExportDir: path.join(dir, "exports"),
      kbDir: path.join(dir, "missing-kb"),
      codexBin: "/missing/codex",
      timezone: "Asia/Shanghai",
      managerUserId: "user-1",
      feishuReceiveId: "user-1",
      feishuReceiveIdType: "open_id",
      schedule: {
        plan: "08:30", firstTask: "10:00", midday: "12:00", afternoon: "14:00",
        dayClose: "18:00", eveningStart: "20:00", eveningEnd: "22:00", noResponseMinutes: 15,
      },
    },
    {
      clock: { now: () => new Date("2026-07-11T00:00:00.000Z") },
      connectFeishu: async () => ({ stop: async () => {} }),
      setInterval: (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; },
      clearInterval: () => {},
    },
  );

  await app.start();
  const pending = app.state.ops.listReminders({ status: "pending" });
  assert.equal(pending.filter((row) => row.kind === "daily_plan").length, 7);
  assert.equal(pending.filter((row) => row.kind === "daily_review").length, 7);
  assert.equal(intervals.length, 2);
  assert.equal(app.state.ops.listOutbox().some((row) => row.kind === "recovery_plan_card"), true);
  assert.equal(app.state.settings.maxCriticalTasks, 5);
  assert.deepEqual(app.state.settings.projectMinimums, { "个人IP": 2, "极享OS": 2 });
  assert.deepEqual(app.state.settings.projectWindows["个人IP"], [["10:00", "12:00"], ["14:00", "16:00"]]);
  await app.stop();
});
