import { randomUUID } from "node:crypto";

export function createProjectOperationsRepository(db, deps = {}) {
  const now = deps.now || (() => new Date().toISOString());
  const id = deps.id || randomUUID;

  function getWeeklyPlan(weekId, version) {
    const row = db.prepare("SELECT * FROM weekly_plans WHERE week_id = ? AND version = ?").get(weekId, version);
    return row ? mapWeeklyPlan(row) : null;
  }

  function saveWeeklyPlan(input) {
    const existing = db.prepare("SELECT * FROM weekly_plans WHERE week_id = ? AND version = ?")
      .get(input.weekId, input.version);
    if (existing?.status === "confirmed") {
      const isUnchanged = input.status === "confirmed"
        && input.markdownPath === existing.markdown_path
        && input.contentHash === existing.content_hash
        && JSON.stringify(input.plan) === existing.plan_json;
      if (!isUnchanged) throw new Error("confirmed weekly plan cannot be changed");
      return mapWeeklyPlan(existing);
    }
    db.prepare(`INSERT INTO weekly_plans
      (week_id,version,markdown_path,content_hash,status,plan_json,created_at)
      VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(week_id,version) DO UPDATE SET
        markdown_path=excluded.markdown_path, content_hash=excluded.content_hash,
        status=excluded.status, plan_json=excluded.plan_json`).run(
      input.weekId,
      input.version,
      input.markdownPath,
      input.contentHash,
      input.status,
      JSON.stringify(input.plan),
      input.createdAt || now(),
    );
    return getWeeklyPlan(input.weekId, input.version);
  }

  function getLatestWeeklyPlan(weekId) {
    const row = db.prepare("SELECT * FROM weekly_plans WHERE week_id = ? ORDER BY version DESC LIMIT 1").get(weekId);
    return row ? mapWeeklyPlan(row) : null;
  }

  function getConfirmedWeeklyPlan(weekId) {
    const row = db.prepare(`SELECT * FROM weekly_plans
      WHERE week_id = ? AND status = 'confirmed' ORDER BY version DESC LIMIT 1`).get(weekId);
    return row ? mapWeeklyPlan(row) : null;
  }

  function confirmWeeklyPlan({ weekId, version, eventId }) {
    if (eventId) {
      const duplicate = db.prepare("SELECT * FROM weekly_plans WHERE confirmation_event_id = ?").get(eventId);
      if (duplicate) return mapWeeklyPlan(duplicate);
    }
    const result = db.prepare(`UPDATE weekly_plans
      SET status = 'confirmed', confirmed_at = ?, confirmation_event_id = ?
      WHERE week_id = ? AND version = ?`).run(now(), eventId || null, weekId, version);
    if (!result.changes) throw new Error(`weekly plan not found: ${weekId} version ${version}`);
    return getWeeklyPlan(weekId, version);
  }

  function beginWeeklyPlanConfirmation({ weekId, version, eventId }) {
    const current = getWeeklyPlan(weekId, version);
    if (!current) throw new Error(`weekly plan not found: ${weekId} version ${version}`);
    if (current.status === "confirmed" || current.status === "confirming") return current;
    const plan = { ...current.plan, confirmation: { eventId: eventId || null, appliedProjectIds: [] } };
    const result = db.prepare(`UPDATE weekly_plans SET status='confirming', plan_json=?, confirmation_event_id=?
      WHERE week_id=? AND version=? AND status='draft'`).run(JSON.stringify(plan), eventId || null, weekId, version);
    if (!result.changes) throw new Error(`weekly plan cannot begin confirmation: ${weekId} version ${version}`);
    return getWeeklyPlan(weekId, version);
  }

  function markWeeklyPlanProjectApplied({ weekId, version, projectId }) {
    const current = getWeeklyPlan(weekId, version);
    if (!current || current.status !== "confirming") throw new Error("weekly plan is not confirming");
    const appliedProjectIds = [...new Set([...(current.plan.confirmation?.appliedProjectIds || []), projectId])];
    const plan = { ...current.plan, confirmation: { ...current.plan.confirmation, appliedProjectIds } };
    db.prepare("UPDATE weekly_plans SET plan_json=? WHERE week_id=? AND version=? AND status='confirming'")
      .run(JSON.stringify(plan), weekId, version);
    return getWeeklyPlan(weekId, version);
  }

  function finalizeWeeklyPlanConfirmation({ weekId, version, markdownPath, contentHash }) {
    const confirming = getWeeklyPlan(weekId, version);
    const result = db.prepare(`UPDATE weekly_plans SET status='confirmed', confirmed_at=?,
      confirmation_event_id=?, markdown_path=?, content_hash=?
      WHERE week_id=? AND version=? AND status='confirming'`)
      .run(now(), confirming?.confirmationEventId || null, markdownPath, contentHash, weekId, version);
    if (!result.changes) {
      const current = getWeeklyPlan(weekId, version);
      if (current?.status === "confirmed") return current;
      throw new Error(`weekly plan is not confirming: ${weekId} version ${version}`);
    }
    return getWeeklyPlan(weekId, version);
  }

  function getAcceptance(acceptanceId) {
    const row = db.prepare("SELECT * FROM task_acceptances WHERE id = ?").get(acceptanceId);
    return row ? mapAcceptance(row) : null;
  }

  function saveAcceptance(input) {
    if (input.idempotencyKey) {
      const duplicate = db.prepare("SELECT * FROM task_acceptances WHERE idempotency_key = ?").get(input.idempotencyKey);
      if (duplicate) return mapAcceptance(duplicate);
    }
    const acceptanceId = input.id || id();
    db.prepare(`INSERT INTO task_acceptances
      (id,task_id,deliverable_id,evidence_json,status,explanation,idempotency_key,created_at,decided_at)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(
      acceptanceId,
      input.taskId,
      input.deliverableId,
      JSON.stringify(input.evidence ?? []),
      input.status || "pending",
      input.explanation || "",
      input.idempotencyKey || null,
      input.createdAt || now(),
      input.decidedAt || null,
    );
    return getAcceptance(acceptanceId);
  }

  function findPendingAcceptanceByTask(taskId) {
    const row = db.prepare(`SELECT * FROM task_acceptances
      WHERE task_id = ? AND status = 'pending' ORDER BY created_at DESC, id DESC LIMIT 1`).get(taskId);
    return row ? mapAcceptance(row) : null;
  }

  function decideAcceptance(input) {
    const acceptanceId = input.id || input.acceptanceId;
    const current = getAcceptance(acceptanceId);
    const result = db.prepare(`UPDATE task_acceptances
      SET status = ?, explanation = ?, evidence_json = ?, decided_at = ? WHERE id = ?`).run(
      input.status,
      input.explanation || "",
      JSON.stringify(input.evidence ?? current?.evidence ?? []),
      input.decidedAt === undefined ? now() : input.decidedAt,
      acceptanceId,
    );
    if (!result.changes) throw new Error(`acceptance not found: ${acceptanceId}`);
    return getAcceptance(acceptanceId);
  }

  function getSyncState(projectId) {
    const row = db.prepare("SELECT * FROM project_sync_state WHERE project_id = ?").get(projectId);
    return row ? mapSyncState(row) : null;
  }

  function saveSyncState(input) {
    db.prepare(`INSERT INTO project_sync_state
      (project_id,file_path,content_hash,last_written_version,last_error,updated_at)
      VALUES (?,?,?,?,?,?)
      ON CONFLICT(project_id) DO UPDATE SET
        file_path=excluded.file_path, content_hash=excluded.content_hash,
        last_written_version=excluded.last_written_version, last_error=excluded.last_error,
        updated_at=excluded.updated_at`).run(
      input.projectId,
      input.filePath,
      input.contentHash,
      input.lastWrittenVersion ?? 0,
      input.lastError ?? null,
      input.updatedAt || now(),
    );
    return getSyncState(input.projectId);
  }

  return {
    saveWeeklyPlan,
    getWeeklyPlan,
    getLatestWeeklyPlan,
    getConfirmedWeeklyPlan,
    confirmWeeklyPlan,
    beginWeeklyPlanConfirmation,
    markWeeklyPlanProjectApplied,
    finalizeWeeklyPlanConfirmation,
    saveAcceptance,
    getAcceptance,
    findPendingAcceptanceByTask,
    decideAcceptance,
    getSyncState,
    saveSyncState,
  };
}

function mapWeeklyPlan(row) {
  return {
    weekId: row.week_id,
    version: row.version,
    markdownPath: row.markdown_path,
    contentHash: row.content_hash,
    status: row.status,
    plan: parseJson(row.plan_json, {}),
    createdAt: row.created_at,
    confirmedAt: row.confirmed_at,
    confirmationEventId: row.confirmation_event_id,
  };
}

function mapAcceptance(row) {
  return {
    id: row.id,
    taskId: row.task_id,
    deliverableId: row.deliverable_id,
    evidence: parseJson(row.evidence_json, []),
    status: row.status,
    explanation: row.explanation,
    idempotencyKey: row.idempotency_key,
    createdAt: row.created_at,
    decidedAt: row.decided_at,
  };
}

function mapSyncState(row) {
  return {
    projectId: row.project_id,
    filePath: row.file_path,
    contentHash: row.content_hash,
    lastWrittenVersion: row.last_written_version,
    lastError: row.last_error,
    updatedAt: row.updated_at,
  };
}

function parseJson(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}
