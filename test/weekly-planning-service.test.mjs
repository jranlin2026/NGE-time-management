import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openDatabase } from "../src/db/database.mjs";
import { createOperationsRepository } from "../src/db/operations-repository.mjs";
import { createProjectOperationsRepository } from "../src/db/project-operations-repository.mjs";
import { createProjectMarkdownRepository } from "../src/lib/project-markdown-repository.mjs";
import { createWeeklyPlanRepository } from "../src/lib/weekly-plan-repository.mjs";
import { createWeeklyPlanningService } from "../src/lib/weekly-planning-service.mjs";

const PROJECT_SPEC = {
  projectId: "personal-ip", name: "个人IP", milestoneId: "launch", milestoneName: "启动",
  deliverableId: "first", deliverableName: "首个交付项",
};

async function setup({ hooks = {}, activate = true } = {}) {
  const kbDir = await fs.mkdtemp(path.join(os.tmpdir(), "weekly-service-"));
  const db = openDatabase(":memory:");
  const ops = createOperationsRepository(db, { now: () => "2026-07-12T14:00:00.000Z", id: (() => { let n = 0; return () => `id-${++n}`; })() });
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
  const service = createWeeklyPlanningService({ projectRepo: projects, weeklyPlanRepo: weeklyPlans, projectOps, ops, analyzer, hooks });
  return { kbDir, db, ops, projectOps, projects, weeklyPlans, service };
}

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
