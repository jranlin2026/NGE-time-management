export function createWeeklyPlanningService({ projectRepo, weeklyPlanRepo, projectOps, ops, analyzer, hooks = {}, transaction = (fn) => fn() }) {
  async function generateDraft({ weekId, version: requestedVersion } = {}) {
    const allProjects = await projectRepo.listProjects();
    const drafts = allProjects.filter((project) => project.status === "draft");
    if (drafts.length) {
      ops.enqueueOutbox({
        kind: "project_setup_card", payload: { projects: drafts },
        idempotencyKey: `project-setup-card:${drafts.map((project) => project.contentHash).join(":")}`,
      });
      return { status: "setup_required", projects: drafts };
    }
    const projects = allProjects.filter((project) => project.status === "active");
    const latest = projectOps.getLatestWeeklyPlan(weekId);
    const version = requestedVersion === undefined ? (latest?.version || 0) + 1 : Number(requestedVersion);
    const existing = projectOps.getWeeklyPlan(weekId, version);
    if (existing) {
      ops.enqueueOutbox({
        kind: "weekly_plan_card", payload: { plan: existing.plan, weekId, version },
        idempotencyKey: `weekly-plan-card:${weekId}:${version}`,
      });
      return existing;
    }
    const previousPlan = latest?.plan || projectOps.getConfirmedWeeklyPlan(weekId)?.plan || null;
    const plan = await analyzer.analyzeWeeklyPlan({ weekId, projects, previousPlan });
    const markdown = await weeklyPlanRepo.writeDraft({ weekId, version, plan });
    const durablePlan = {
      outcomes: markdown.outcomes,
      deliverableChanges: markdown.deliverableChanges,
      tasks: markdown.tasks,
    };
    const saved = projectOps.saveWeeklyPlan({
      weekId,
      version,
      markdownPath: markdown.filePath,
      contentHash: markdown.contentHash,
      status: "draft",
      plan: durablePlan,
      createdAt: markdown.createdAt,
    });
    ops.enqueueOutbox({
      kind: "weekly_plan_card",
      payload: { plan: durablePlan, weekId, version },
      idempotencyKey: `weekly-plan-card:${weekId}:${version}`,
    });
    return saved;
  }

  async function confirm({ weekId, version, eventId }) {
    const numericVersion = Number(version);
    const stored = projectOps.getWeeklyPlan(weekId, numericVersion);
    if (!stored) throw new Error(`weekly plan not found: ${weekId} version ${numericVersion}`);
    if (stored.status === "confirmed") {
      const confirmationEventId = stored.confirmationEventId || stored.plan.confirmation?.eventId;
      ops.appendEvent({
        kind: "weekly_plan_confirmed", payload: { weekId, version: numericVersion },
        idempotencyKey: confirmationEventId
          ? `weekly-plan-confirmed:${confirmationEventId}`
          : `weekly-plan-confirmed:${weekId}:${numericVersion}`,
      });
      return stored;
    }
    let progress = projectOps.beginWeeklyPlanConfirmation({ weekId, version: numericVersion, eventId });
    await hooks.afterBegin?.(progress);
    const changesByProject = Map.groupBy(progress.plan.deliverableChanges || [], (change) => change.projectId);
    for (const [projectId, changes] of changesByProject) {
      if (progress.plan.confirmation?.appliedProjectIds?.includes(projectId)) continue;
      const project = await projectRepo.readProject(projectId);
      await projectRepo.applyDeliverableChanges({
        projectId,
        expectedHash: project.contentHash,
        changes,
        reason: `weekly plan confirmed: ${weekId} v${numericVersion}`,
        operationKey: `weekly:${weekId}:${numericVersion}:${projectId}`,
      });
      progress = projectOps.markWeeklyPlanProjectApplied({ weekId, version: numericVersion, projectId });
      await hooks.afterProject?.({ projectId, progress });
    }
    const confirmedMarkdown = await weeklyPlanRepo.confirm({
      weekId, version: numericVersion, expectedHash: stored.contentHash,
    });
    await hooks.afterCanonical?.(confirmedMarkdown);
    await hooks.beforeFinalize?.(progress);
    const result = transaction(() => {
      const finalized = projectOps.finalizeWeeklyPlanConfirmation({
        weekId, version: numericVersion, markdownPath: confirmedMarkdown.filePath, contentHash: confirmedMarkdown.contentHash,
      });
      ops.appendEvent({
        kind: "weekly_plan_confirmed", payload: { weekId, version: numericVersion },
        idempotencyKey: finalized.confirmationEventId
          ? `weekly-plan-confirmed:${finalized.confirmationEventId}`
          : `weekly-plan-confirmed:${weekId}:${numericVersion}`,
      });
      return finalized;
    });
    return result;
  }

  async function requestAdjustment({ weekId, version, reason, eventId }) {
    const numericVersion = Number(version);
    const plan = projectOps.getWeeklyPlan(weekId, numericVersion);
    if (!plan) throw new Error(`weekly plan not found: ${weekId} version ${numericVersion}`);
    const eventKey = eventId ? `weekly-plan-adjustment:${eventId}` : `weekly-plan-adjustment:${weekId}:${numericVersion}`;
    const duplicate = eventKey ? ops.findEventByIdempotencyKey(eventKey) : null;
    const targetVersion = duplicate?.payload.targetVersion || ((projectOps.getLatestWeeklyPlan(weekId)?.version || 0) + 1);
    if (!duplicate) ops.appendEvent({
      kind: "weekly_plan_adjustment_requested", payload: { weekId, version: numericVersion, reason, targetVersion }, idempotencyKey: eventKey,
    });
    await hooks.afterAdjustmentReservation?.({ weekId, version: numericVersion, targetVersion });
    const generated = await generateDraft({ weekId, version: targetVersion });
    await hooks.afterAdjustmentDraft?.(generated);
    return generated;
  }

  async function getEffectivePlan({ weekId, previousWeekId }) {
    return projectOps.getConfirmedWeeklyPlan(weekId)
      || projectOps.getConfirmedWeeklyPlan(previousWeekId)
      || null;
  }

  return { generateDraft, confirm, requestAdjustment, getEffectivePlan };
}
