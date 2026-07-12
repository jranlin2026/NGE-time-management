import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openDatabase, withTransaction } from "../src/db/database.mjs";
import { createOperationsRepository } from "../src/db/operations-repository.mjs";
import { createProjectOperationsRepository } from "../src/db/project-operations-repository.mjs";
import { createProjectMarkdownRepository } from "../src/lib/project-markdown-repository.mjs";
import { createWeeklyPlanRepository } from "../src/lib/weekly-plan-repository.mjs";
import { createWeeklyPlanningService } from "../src/lib/weekly-planning-service.mjs";

const PROJECT_SPEC = {
  projectId: "personal-ip", name: "个人IP", milestoneId: "launch", milestoneName: "启动",
  deliverableId: "first", deliverableName: "首个交付项",
};

async function setup({ hooks = {}, activate = true, failConfirmedEventOnce = false } = {}) {
  const kbDir = await fs.mkdtemp(path.join(os.tmpdir(), "weekly-service-"));
  const db = openDatabase(":memory:");
  const realOps = createOperationsRepository(db, { now: () => "2026-07-12T14:00:00.000Z", id: (() => { let n = 0; return () => `id-${++n}`; })() });
  let shouldFailConfirmedEvent = failConfirmedEventOnce;
  const ops = new Proxy(realOps, { get(target, key) {
    if (key !== "appendEvent") return target[key];
    return (input) => {
      const result = target.appendEvent(input);
      if (shouldFailConfirmedEvent && input.kind === "weekly_plan_confirmed") {
        shouldFailConfirmedEvent = false;
        throw new Error("crash:confirmed-event");
      }
      return result;
    };
  } });
  const projectOps = createProjectOperationsRepository(db, { now: () => "2026-07-12T14:00:00.000Z" });
  const projects = createProjectMarkdownRepository({ kbDir, now: () => "2026-07-12T14:00:00.000Z" });
  await projects.ensureDraftTemplates([PROJECT_SPEC]);
  const draftProject = await projects.readProject("personal-ip");
  if (activate) await projects.confirmDraft("personal-ip", draftProject.contentHash);
  const weeklyPlans = createWeeklyPlanRepository({ kbDir, now: () => "2026-07-12T14:00:00.000Z" });
  const analyzer = { analyzeWeeklyPlan: async () => ({
    outcomes: ["交付第二个成果"],
    deliverableChanges: [{ action: "update", projectId: "personal-ip", milestoneId: "launch", deliverableId: "first", name: "第二个成果", weight: 100 }],
    tasks: [],
  }) };
  const service = createWeeklyPlanningService({
    projectRepo: projects, weeklyPlanRepo: weeklyPlans, projectOps, ops, analyzer, hooks,
    transaction: (fn) => withTransaction(db, fn),
  });
  return { kbDir, db, ops, projectOps, projects, weeklyPlans, service };
}

test("rolls back final confirmation when the confirmed event cannot be appended", async (t) => {
  const fixture = await setup({ failConfirmedEventOnce: true });
  t.after(async () => { fixture.db.close(); await fs.rm(fixture.kbDir, { recursive: true, force: true }); });
  const draft = await fixture.service.generateDraft({ weekId: "2026-W29" });

  await assert.rejects(
    fixture.service.confirm({ weekId: "2026-W29", version: draft.version, eventId: "evt-confirm" }),
    /crash:confirmed-event/,
  );
  assert.equal(fixture.projectOps.getWeeklyPlan("2026-W29", 1).status, "confirming");
  assert.equal(fixture.ops.listEvents({ kind: "weekly_plan_confirmed" }).length, 0);

  const confirmed = await fixture.service.confirm({ weekId: "2026-W29", version: 1, eventId: "evt-retry" });
  assert.equal(confirmed.status, "confirmed");
  assert.equal(fixture.ops.listEvents({ kind: "weekly_plan_confirmed" }).length, 1);
});

test("generates the next versioned draft in both stores and queues one confirmation card", async (t) => {
  const fixture = await setup();
  t.after(async () => { fixture.db.close(); await fs.rm(fixture.kbDir, { recursive: true, force: true }); });

  const result = await fixture.service.generateDraft({ weekId: "2026-W29" });

  assert.equal(result.status, "draft");
  assert.equal(result.version, 1);
  assert.equal(fixture.projectOps.getWeeklyPlan("2026-W29", 1).contentHash, result.contentHash);
  assert.equal(fixture.ops.listOutbox().at(-1).kind, "weekly_plan_card");
  await fixture.service.generateDraft({ weekId: "2026-W29" });
  assert.equal(fixture.projectOps.getLatestWeeklyPlan("2026-W29").version, 2);
});

test("adopts an orphan draft after file publication and persists its original plan exactly once", async (t) => {
  const fixture = await setup();
  t.after(async () => { fixture.db.close(); await fs.rm(fixture.kbDir, { recursive: true, force: true }); });
  const originalPlan = {
    outcomes: ["原始孤儿成果"], deliverableChanges: [],
    tasks: [{ taskId: "orphan", projectId: "personal-ip", projectName: "个人IP", milestoneId: "launch", deliverableId: "first", title: "原始任务", deliverable: "原始交付", completionStandard: "完成", minutes: 30, date: "2026-07-13", requiresEvidence: true, impact: "normal" }],
  };
  const orphan = await fixture.weeklyPlans.writeDraft({ weekId: "2026-W29", version: 1, plan: originalPlan });
  fixture.service = createWeeklyPlanningService({
    projectRepo: fixture.projects, weeklyPlanRepo: fixture.weeklyPlans, projectOps: fixture.projectOps,
    ops: fixture.ops, analyzer: { analyzeWeeklyPlan: async () => ({ outcomes: ["重试成果"], deliverableChanges: [], tasks: [] }) },
    transaction: (fn) => withTransaction(fixture.db, fn),
  });

  const saved = await fixture.service.generateDraft({ weekId: "2026-W29", version: 1 });

  assert.equal(saved.contentHash, orphan.contentHash);
  assert.deepEqual(saved.plan, originalPlan);
  assert.deepEqual(fixture.ops.listOutbox().filter((row) => row.kind === "weekly_plan_card").map((row) => row.payload.plan), [originalPlan]);
  assert.equal(fixture.projectOps.getLatestWeeklyPlan("2026-W29").version, 1);
});

test("uses the previous confirmed plan while the current week remains unconfirmed", async (t) => {
  const fixture = await setup();
  t.after(async () => { fixture.db.close(); await fs.rm(fixture.kbDir, { recursive: true, force: true }); });
  const draft = await fixture.service.generateDraft({ weekId: "2026-W28" });
  await fixture.service.confirm({ weekId: "2026-W28", version: draft.version, eventId: "evt-prev" });
  await fixture.service.generateDraft({ weekId: "2026-W29" });

  const effective = await fixture.service.getEffectivePlan({ weekId: "2026-W29", previousWeekId: "2026-W28" });
  assert.equal(effective.weekId, "2026-W28");
});

test("confirms one unchanged draft, applies its deliverable changes, and records the event idempotently", async (t) => {
  const fixture = await setup();
  t.after(async () => { fixture.db.close(); await fs.rm(fixture.kbDir, { recursive: true, force: true }); });
  const draft = await fixture.service.generateDraft({ weekId: "2026-W29" });

  const first = await fixture.service.confirm({ weekId: "2026-W29", version: draft.version, eventId: "evt-confirm" });
  const repeated = await fixture.service.confirm({ weekId: "2026-W29", version: draft.version, eventId: "evt-confirm" });

  assert.equal(first.status, "confirmed");
  assert.equal(repeated.confirmationEventId, "evt-confirm");
  assert.equal((await fixture.projects.readProject("personal-ip")).milestones[0].deliverables[0].name, "第二个成果");
  assert.equal(fixture.ops.listEvents({ kind: "weekly_plan_confirmed" }).length, 1);
});

test("records an adjustment request without confirming the draft", async (t) => {
  const fixture = await setup();
  t.after(async () => { fixture.db.close(); await fs.rm(fixture.kbDir, { recursive: true, force: true }); });
  const draft = await fixture.service.generateDraft({ weekId: "2026-W29" });

  const adjusted = await fixture.service.requestAdjustment({ weekId: "2026-W29", version: draft.version, reason: "任务太多", eventId: "evt-adjust" });
  const repeated = await fixture.service.requestAdjustment({ weekId: "2026-W29", version: draft.version, reason: "重复消息", eventId: "evt-adjust" });

  assert.equal(fixture.projectOps.getWeeklyPlan("2026-W29", 1).status, "draft");
  assert.equal(adjusted.version, 2);
  assert.equal(repeated.version, 2);
  assert.equal(fixture.projectOps.getLatestWeeklyPlan("2026-W29").version, 2);
  assert.equal(fixture.ops.listEvents({ kind: "weekly_plan_adjustment_requested" }).length, 1);
});

test("refuses partial weekly generation while any project remains draft", async (t) => {
  const fixture = await setup({ activate: false });
  t.after(async () => { fixture.db.close(); await fs.rm(fixture.kbDir, { recursive: true, force: true }); });

  const result = await fixture.service.generateDraft({ weekId: "2026-W29" });

  assert.equal(result.status, "setup_required");
  assert.equal(fixture.projectOps.getLatestWeeklyPlan("2026-W29"), null);
  assert.equal(fixture.ops.listOutbox().at(-1).kind, "project_setup_card");
});

for (const crashPoint of ["afterBegin", "afterProject", "afterCanonical", "beforeFinalize"]) {
  test(`resumes confirmation after ${crashPoint} without duplicate project logs`, async (t) => {
    let crashed = false;
    const fixture = await setup({ hooks: {
      [crashPoint]: async () => {
        if (!crashed) { crashed = true; throw new Error(`crash:${crashPoint}`); }
      },
    } });
    t.after(async () => { fixture.db.close(); await fs.rm(fixture.kbDir, { recursive: true, force: true }); });
    const draft = await fixture.service.generateDraft({ weekId: "2026-W29" });

    await assert.rejects(
      fixture.service.confirm({ weekId: "2026-W29", version: draft.version, eventId: "evt-original" }),
      new RegExp(`crash:${crashPoint}`),
    );
    assert.equal(fixture.projectOps.getWeeklyPlan("2026-W29", 1).status, "confirming");
    const result = await fixture.service.confirm({ weekId: "2026-W29", version: 1, eventId: "evt-retry" });

    assert.equal(result.status, "confirmed");
    assert.equal(result.confirmationEventId, "evt-original");
    const logDir = path.join(fixture.kbDir, "项目变更记录");
    const logs = await fs.readdir(logDir).catch(() => []);
    assert.equal(logs.length, 1);
  });
}

for (const crashPoint of ["afterAdjustmentReservation", "afterAdjustmentDraft"]) {
  test(`resumes adjustment after ${crashPoint} at the reserved version`, async (t) => {
    let crashed = false;
    const fixture = await setup({ hooks: { [crashPoint]: async () => {
      if (!crashed) { crashed = true; throw new Error(`crash:${crashPoint}`); }
    } } });
    t.after(async () => { fixture.db.close(); await fs.rm(fixture.kbDir, { recursive: true, force: true }); });
    const draft = await fixture.service.generateDraft({ weekId: "2026-W29" });

    await assert.rejects(
      fixture.service.requestAdjustment({ weekId: "2026-W29", version: draft.version, reason: "任务太多", eventId: "evt-adjust-crash" }),
      new RegExp(`crash:${crashPoint}`),
    );
    const result = await fixture.service.requestAdjustment({
      weekId: "2026-W29", version: draft.version, reason: "不应覆盖", eventId: "evt-adjust-crash",
    });

    assert.equal(result.version, 2);
    assert.equal(fixture.projectOps.getLatestWeeklyPlan("2026-W29").version, 2);
    assert.equal(fixture.ops.listEvents({ kind: "weekly_plan_adjustment_requested" }).length, 1);
    assert.equal(fixture.ops.listOutbox().filter((row) => row.kind === "weekly_plan_card" && row.payload.version === 2).length, 1);
  });
}
