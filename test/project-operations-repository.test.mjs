import assert from "node:assert/strict";
import test from "node:test";
import { openDatabase } from "../src/db/database.mjs";
import { createProjectOperationsRepository } from "../src/db/project-operations-repository.mjs";
import { createTaskRepository } from "../src/db/task-repository.mjs";

const NOW = "2026-07-12T10:00:00.000Z";

function setup() {
  const db = openDatabase(":memory:");
  let sequence = 0;
  return {
    db,
    repo: createProjectOperationsRepository(db, {
      now: () => NOW,
      id: () => `acceptance-${++sequence}`,
    }),
  };
}

test("saves, queries, and idempotently confirms weekly plans", () => {
  const { db, repo } = setup();
  repo.saveWeeklyPlan({
    weekId: "2026-W29",
    version: 1,
    markdownPath: "/weekly/2026-W29.md",
    contentHash: "abc",
    status: "draft",
    plan: { tasks: [{ id: "task-1" }] },
  });
  repo.saveWeeklyPlan({
    weekId: "2026-W29",
    version: 2,
    markdownPath: "/weekly/2026-W29-v2.md",
    contentHash: "def",
    status: "draft",
    plan: { tasks: [] },
  });

  assert.deepEqual(repo.getWeeklyPlan("2026-W29", 1).plan, { tasks: [{ id: "task-1" }] });
  assert.equal(repo.getLatestWeeklyPlan("2026-W29").version, 2);
  assert.equal(repo.getConfirmedWeeklyPlan("2026-W29"), null);

  const first = repo.confirmWeeklyPlan({ weekId: "2026-W29", version: 1, eventId: "evt-1" });
  const duplicate = repo.confirmWeeklyPlan({ weekId: "2026-W29", version: 1, eventId: "evt-1" });
  assert.deepEqual(duplicate, first);
  assert.equal(first.status, "confirmed");
  assert.equal(first.confirmedAt, NOW);
  assert.equal(repo.getConfirmedWeeklyPlan("2026-W29").version, 1);
  db.close();
});

test("saves acceptances idempotently and decides pending acceptance", () => {
  const { db, repo } = setup();
  createTaskRepository(db, { now: () => NOW, id: () => "task-1" }).create({
    id: "task-1",
    rawInput: "提交交付物",
  });

  const first = repo.saveAcceptance({
    taskId: "task-1",
    deliverableId: "deliverable-1",
    evidence: [{ type: "link", url: "https://example.com/result" }],
    status: "pending",
    explanation: "等待验收",
    idempotencyKey: "submit-1",
  });
  const duplicate = repo.saveAcceptance({
    taskId: "task-1",
    deliverableId: "deliverable-1",
    evidence: [],
    status: "pending",
    explanation: "重复提交不会覆盖",
    idempotencyKey: "submit-1",
  });

  assert.equal(duplicate.id, first.id);
  assert.deepEqual(repo.getAcceptance(first.id).evidence, [{ type: "link", url: "https://example.com/result" }]);
  assert.equal(repo.findPendingAcceptanceByTask("task-1").id, first.id);

  const decided = repo.decideAcceptance({ id: first.id, status: "accepted", explanation: "证据充分" });
  assert.equal(decided.status, "accepted");
  assert.equal(decided.explanation, "证据充分");
  assert.equal(decided.decidedAt, NOW);
  assert.equal(repo.findPendingAcceptanceByTask("task-1"), null);
  db.close();
});

test("upserts and maps project sync state", () => {
  const { db, repo } = setup();
  assert.equal(repo.getSyncState("personal-ip"), null);

  repo.saveSyncState({
    projectId: "personal-ip",
    filePath: "/projects/personal-ip.md",
    contentHash: "hash-1",
    lastWrittenVersion: 1,
    lastError: "temporary",
  });
  const updated = repo.saveSyncState({
    projectId: "personal-ip",
    filePath: "/projects/personal-ip.md",
    contentHash: "hash-2",
    lastWrittenVersion: 2,
    lastError: null,
  });

  assert.deepEqual(updated, {
    projectId: "personal-ip",
    filePath: "/projects/personal-ip.md",
    contentHash: "hash-2",
    lastWrittenVersion: 2,
    lastError: null,
    updatedAt: NOW,
  });
  assert.deepEqual(repo.getSyncState("personal-ip"), updated);
  db.close();
});
