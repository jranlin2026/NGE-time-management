import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { addTask, readTasks } from "../src/lib/task-store.mjs";

test("adds and reads markdown tasks", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "time-master-"));
  await addTask(dir, {
    title: "完成直播 PPT",
    project: "直播",
    importance: "S",
    urgency: "high",
    due: "2026-07-08",
    nextAction: "写大纲",
  });
  const tasks = await readTasks(dir);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].title, "完成直播 PPT");
  assert.equal(tasks[0].project, "直播");
});
