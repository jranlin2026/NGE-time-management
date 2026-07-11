import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { openDatabase, withTransaction } from "../src/db/database.mjs";
import { createTaskRepository } from "../src/db/task-repository.mjs";
import { createOperationsRepository } from "../src/db/operations-repository.mjs";
import { writeTasks } from "../src/lib/task-store.mjs";

const NOW = "2026-07-10T00:30:00.000Z";

function setup() {
  const db = openDatabase(":memory:");
  let sequence = 0;
  const id = () => `id-${++sequence}`;
  return {
    db,
    tasks: createTaskRepository(db, { now: () => NOW, id }),
    ops: createOperationsRepository(db, { now: () => NOW, id }),
  };
}

test("creates one task per Feishu message and records event plus outbox atomically", () => {
  const { db, tasks, ops } = setup();
  const first = withTransaction(db, () => {
    const task = tasks.create({ rawInput: "拍 3 条视频", sourceMessageId: "om-1" });
    ops.appendEvent({ taskId: task.id, kind: "task_created", idempotencyKey: "msg:om-1" });
    ops.enqueueOutbox({ kind: "text", payload: { text: "已入池" }, idempotencyKey: "ack:om-1" });
    return task;
  });
  const duplicate = tasks.create({ rawInput: "拍 3 条视频", sourceMessageId: "om-1" });

  assert.equal(first.id, duplicate.id);
  assert.equal(db.prepare("SELECT count(*) AS count FROM tasks").get().count, 1);
  assert.equal(db.prepare("SELECT count(*) AS count FROM task_events").get().count, 1);
  assert.equal(db.prepare("SELECT count(*) AS count FROM outbox").get().count, 1);
  db.close();
});

test("updates only allowed task columns", () => {
  const { db, tasks } = setup();
  tasks.create({ id: "task-1", rawInput: "优化极享 OS", sourceMessageId: "om-2" });
  const updated = tasks.update("task-1", {
    status: "ready",
    title: "完成极享 OS 优化",
    estimateMinutes: 120,
  });

  assert.equal(updated.status, "ready");
  assert.equal(updated.estimateMinutes, 120);
  assert.throws(() => tasks.update("task-1", { createdAt: "changed" }), /unsupported task field/);
  db.close();
});

test("persists, maps, and updates project execution fields", () => {
  const { db, tasks } = setup();
  const created = tasks.create({
    id: "task-project",
    rawInput: "完成首条口播",
    projectId: "personal-ip",
    milestoneId: "m1",
    deliverableId: "d1",
    requiresEvidence: true,
    impact: "high",
  });

  assert.equal(created.projectId, "personal-ip");
  assert.equal(created.milestoneId, "m1");
  assert.equal(created.deliverableId, "d1");
  assert.equal(created.requiresEvidence, true);
  assert.equal(created.impact, "high");

  const updated = tasks.update(created.id, {
    projectId: "product",
    milestoneId: "m2",
    deliverableId: "d2",
    requiresEvidence: false,
    impact: "normal",
  });
  assert.deepEqual(
    {
      projectId: updated.projectId,
      milestoneId: updated.milestoneId,
      deliverableId: updated.deliverableId,
      requiresEvidence: updated.requiresEvidence,
      impact: updated.impact,
    },
    {
      projectId: "product",
      milestoneId: "m2",
      deliverableId: "d2",
      requiresEvidence: false,
      impact: "normal",
    },
  );
  db.close();
});

test("persists and completes task checkpoints", () => {
  const { db, tasks } = setup();
  const created = tasks.create({
    id: "task-checkpoints",
    rawInput: "完成第一条口播",
    checkpoints: ["写完脚本", "录制素材", "提交剪辑"],
  });

  assert.deepEqual(created.checkpoints, [
    { title: "写完脚本", completed: false },
    { title: "录制素材", completed: false },
    { title: "提交剪辑", completed: false },
  ]);
  const updated = tasks.completeCheckpoint(created.id, 1);
  assert.equal(updated.checkpoints[1].completed, true);
  assert.equal(tasks.findById(created.id).checkpoints[0].completed, false);
  db.close();
});

test("replaces schedules by version without deleting history", () => {
  const { db, tasks, ops } = setup();
  tasks.create({ id: "task-1", rawInput: "拍视频" });
  const first = ops.replaceSchedule({
    date: "2026-07-10",
    blocks: [{ taskId: "task-1", startsAt: "2026-07-10T02:00:00.000Z", endsAt: "2026-07-10T04:00:00.000Z", reason: "个人IP优先" }],
  });
  const second = ops.replaceSchedule({
    date: "2026-07-10",
    blocks: [{ taskId: "task-1", startsAt: "2026-07-10T02:30:00.000Z", endsAt: "2026-07-10T04:30:00.000Z", reason: "延迟30分钟" }],
  });

  assert.equal(first.version, 1);
  assert.equal(second.version, 2);
  assert.equal(ops.currentSchedule("2026-07-10")[0].startsAt, "2026-07-10T02:30:00.000Z");
  assert.equal(db.prepare("SELECT count(*) AS count FROM schedule_blocks").get().count, 2);
  db.close();
});

test("imports legacy Markdown tasks once", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "time-manager-legacy-"));
  await writeTasks(dir, [{ id: "legacy-1", title: "确认直播复盘", project: "个人IP", status: "open", estimateMinutes: 45 }]);
  const { db, tasks } = setup();

  assert.equal(await tasks.importMarkdown(dir), 1);
  assert.equal(await tasks.importMarkdown(dir), 0);
  assert.equal(tasks.findById("legacy-1").status, "ready");
  assert.equal(tasks.findById("legacy-1").analysisStatus, "legacy");
  db.close();
});
