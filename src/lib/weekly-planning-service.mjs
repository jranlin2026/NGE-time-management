export function createWeeklyPlanningService({ projectRepo, weeklyPlanRepo, projectOps, ops, analyzer }) {
  async function generateDraft({ weekId }) {
    const projects = (await projectRepo.listProjects()).filter((project) => project.status === "active");
    const latest = projectOps.getLatestWeeklyPlan(weekId);
    const version = (latest?.version || 0) + 1;
    const previousPlan = projectOps.getConfirmedWeeklyPlan(weekId)?.plan || null;
    const plan = await analyzer.analyzeWeeklyPlan({ weekId, projects, previousPlan });
    const markdown = await weeklyPlanRepo.writeDraft({ weekId, version, plan });
    const saved = projectOps.saveWeeklyPlan({
      weekId,
      version,
      markdownPath: markdown.filePath,
      contentHash: markdown.contentHash,
      status: "draft",
      plan,
      createdAt: markdown.createdAt,
    });
    ops.enqueueOutbox({
      kind: "weekly_plan_card",
      payload: { plan, weekId, version },
      idempotencyKey: `weekly-plan-card:${weekId}:${version}`,
    });
    return saved;
  }

  async function confirm({ weekId, version, eventId }) {
    const numericVersion = Number(version);
    const stored = projectOps.getWeeklyPlan(weekId, numericVersion);
    if (!stored) throw new Error(`weekly plan not found: ${weekId} version ${numericVersion}`);
    if (stored.status === "confirmed") {
      if (!eventId || stored.confirmationEventId === eventId) return stored;
      throw new Error(`weekly plan already confirmed: ${weekId} version ${numericVersion}`);
    }

    const confirmedMarkdown = await weeklyPlanRepo.confirm({
      weekId,
      version: numericVersion,
      expectedHash: stored.contentHash,
    });
    const changesByProject = Map.groupBy(stored.plan.deliverableChanges || [], (change) => change.projectId);
    for (const [projectId, changes] of changesByProject) {
      const project = await projectRepo.readProject(projectId);
      await projectRepo.applyDeliverableChanges({
        projectId,
        expectedHash: project.contentHash,
        changes,
        reason: `weekly plan confirmed: ${weekId} v${numericVersion}`,
      });
    }
    projectOps.saveWeeklyPlan({
      ...stored,
      markdownPath: confirmedMarkdown.filePath,
      contentHash: confirmedMarkdown.contentHash,
      status: "confirmed",
    });
    const result = projectOps.confirmWeeklyPlan({ weekId, version: numericVersion, eventId });
    ops.appendEvent({
      kind: "weekly_plan_confirmed",
      payload: { weekId, version: numericVersion },
      idempotencyKey: eventId ? `weekly-plan-confirmed:${eventId}` : `weekly-plan-confirmed:${weekId}:${numericVersion}`,
    });
    return result;
  }

  async function requestAdjustment({ weekId, version, reason, eventId }) {
    const numericVersion = Number(version);
    const plan = projectOps.getWeeklyPlan(weekId, numericVersion);
    if (!plan) throw new Error(`weekly plan not found: ${weekId} version ${numericVersion}`);
    ops.appendEvent({
      kind: "weekly_plan_adjustment_requested",
      payload: { weekId, version: numericVersion, reason },
      idempotencyKey: eventId ? `weekly-plan-adjustment:${eventId}` : null,
    });
    return plan;
  }

  async function getEffectivePlan({ weekId, previousWeekId }) {
    return projectOps.getConfirmedWeeklyPlan(weekId)
      || projectOps.getConfirmedWeeklyPlan(previousWeekId)
      || null;
  }

  return { generateDraft, confirm, requestAdjustment, getEffectivePlan };
}
