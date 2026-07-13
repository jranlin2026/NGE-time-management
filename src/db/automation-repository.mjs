import { withTransaction } from "./database.mjs";
import { randomUUID } from "node:crypto";
import { sanitizeError } from "../lib/sanitize-error.mjs";

const LOCK_NAME = "global-runner";

function mapRun(row) {
  if (!row) return null;
  return {
    runKey: row.run_key,
    workDate: row.work_date,
    node: row.node,
    status: row.status,
    startedAt: row.started_at,
    expiresAt: row.expires_at,
    claimToken: row.claim_token,
    completedAt: row.completed_at,
    error: row.error,
    summary: JSON.parse(row.summary_json),
  };
}

function mapInbound(row) {
  return {
    messageId: row.message_id,
    chatId: row.chat_id,
    senderId: row.sender_id,
    messageType: row.message_type,
    content: JSON.parse(row.content_json),
    createdAt: row.created_at,
    processedRunKey: row.processed_run_key,
    recordedAt: row.recorded_at,
  };
}

function mapCursor(row) {
  if (!row) return null;
  return { chatId: row.chat_id, polledThrough: row.polled_through, updatedAt: row.updated_at };
}

function mapLink(row) {
  if (!row) return null;
  return {
    localTaskId: row.local_task_id,
    checkpointIndex: row.checkpoint_index,
    taskGuid: row.task_guid,
    parentGuid: row.parent_guid,
    snapshotHash: row.snapshot_hash,
    updatedAt: row.updated_at,
  };
}

export function createAutomationRepository(db, deps = {}) {
  const now = deps.now || (() => new Date().toISOString());
  const newClaimToken = deps.claimToken || randomUUID;

  return {
    claimLock({ owner, expiresAt }) {
      return withTransaction(db, () => {
        const timestamp = now();
        const result = db.prepare(`INSERT INTO automation_locks(lock_name,owner,expires_at,updated_at)
          VALUES (?,?,?,?)
          ON CONFLICT(lock_name) DO UPDATE SET owner=excluded.owner, expires_at=excluded.expires_at,
            updated_at=excluded.updated_at
          WHERE automation_locks.expires_at <= excluded.updated_at`).run(LOCK_NAME, owner, expiresAt, timestamp);
        return result.changes === 1;
      });
    },

    releaseLock(owner) {
      return withTransaction(db, () =>
        db.prepare("DELETE FROM automation_locks WHERE lock_name=? AND owner=?").run(LOCK_NAME, owner).changes === 1,
      );
    },

    claimRun({ runKey, workDate, node, expiresAt }) {
      return withTransaction(db, () => {
        const timestamp = now();
        const existing = db.prepare("SELECT * FROM automation_runs WHERE run_key=?").get(runKey);
        if (!existing) {
          const claimToken = newClaimToken();
          db.prepare(`INSERT INTO automation_runs
            (run_key,work_date,node,status,started_at,expires_at,claim_token,completed_at,error,summary_json)
            VALUES (?,?,?,'running',?,?,?,NULL,NULL,'{}')`).run(runKey, workDate, node, timestamp, expiresAt, claimToken);
          return { claimed: true, claimToken, run: mapRun(db.prepare("SELECT * FROM automation_runs WHERE run_key=?").get(runKey)) };
        }
        if (existing.status === "completed" || (existing.status === "running" && existing.expires_at > timestamp)) {
          return { claimed: false, run: mapRun(existing) };
        }
        const claimToken = newClaimToken();
        db.prepare(`UPDATE automation_runs SET work_date=?, node=?, status='running', started_at=?, expires_at=?, claim_token=?,
          completed_at=NULL, error=NULL, summary_json='{}' WHERE run_key=?`)
          .run(workDate, node, timestamp, expiresAt, claimToken, runKey);
        return { claimed: true, claimToken, run: mapRun(db.prepare("SELECT * FROM automation_runs WHERE run_key=?").get(runKey)) };
      });
    },

    completeRun(runKey, claimToken, summary) {
      return withTransaction(db, () => {
        const result = db.prepare(`UPDATE automation_runs SET status='completed', completed_at=?, error=NULL, summary_json=?
          WHERE run_key=? AND claim_token=? AND status='running'`)
          .run(now(), JSON.stringify(summary ?? {}), runKey, claimToken);
        if (result.changes === 0) return null;
        return mapRun(db.prepare("SELECT * FROM automation_runs WHERE run_key=?").get(runKey));
      });
    },

    failRun(runKey, claimToken, error) {
      return withTransaction(db, () => {
        const result = db.prepare(`UPDATE automation_runs SET status='failed', completed_at=?, error=?
          WHERE run_key=? AND claim_token=? AND status='running'`)
          .run(now(), sanitizeError(error), runKey, claimToken);
        if (result.changes === 0) return null;
        return mapRun(db.prepare("SELECT * FROM automation_runs WHERE run_key=?").get(runKey));
      });
    },

    loadRunAnalysis(runKey) {
      const row = db.prepare("SELECT analysis_json FROM automation_runs WHERE run_key=?").get(runKey);
      return row?.analysis_json ? JSON.parse(row.analysis_json) : null;
    },

    saveRunAnalysis(runKey, claimToken, analysis) {
      return withTransaction(db, () => {
        const result = db.prepare(`UPDATE automation_runs SET analysis_json=COALESCE(analysis_json, ?)
          WHERE run_key=? AND claim_token=? AND status='running'`)
          .run(JSON.stringify(analysis), runKey, claimToken);
        if (result.changes === 0) throw new Error("run analysis requires the current running claim");
        return JSON.parse(db.prepare("SELECT analysis_json FROM automation_runs WHERE run_key=?").get(runKey).analysis_json);
      });
    },

    recordInbound(messages) {
      return withTransaction(db, () => {
        const insert = db.prepare(`INSERT OR IGNORE INTO inbound_messages
          (message_id,chat_id,sender_id,message_type,content_json,created_at,processed_run_key,recorded_at)
          VALUES (?,?,?,?,?,?,NULL,?)`);
        let recorded = 0;
        for (const message of messages) {
          recorded += insert.run(message.messageId, message.chatId, message.senderId, message.messageType,
            JSON.stringify(message.content), message.createdAt, now()).changes;
        }
        return recorded;
      });
    },

    listPendingInbound(chatId, { through } = {}) {
      const cutoff = through ? " AND created_at <= ?" : "";
      return db.prepare(`SELECT * FROM inbound_messages WHERE chat_id=? AND processed_run_key IS NULL${cutoff}
        ORDER BY created_at, message_id`).all(...(through ? [chatId, through] : [chatId])).map(mapInbound);
    },

    getMessageCursor(chatId) {
      return mapCursor(db.prepare("SELECT * FROM message_cursors WHERE chat_id=?").get(chatId));
    },

    finalizeInbound({ chatId, messageIds, runKey, claimToken, polledThrough, summary = {} }) {
      return withTransaction(db, () => {
        const ownsRun = db.prepare(`SELECT 1 FROM automation_runs
          WHERE run_key=? AND claim_token=? AND status='running'`).get(runKey, claimToken);
        if (!ownsRun) throw new Error("inbound finalization requires the current running claim");
        const uniqueMessageIds = [...new Set(messageIds)];
        if (uniqueMessageIds.length > 0) {
          const placeholders = uniqueMessageIds.map(() => "?").join(",");
          const result = db.prepare(`UPDATE inbound_messages SET processed_run_key=?
            WHERE chat_id=? AND processed_run_key IS NULL AND message_id IN (${placeholders})`)
            .run(runKey, chatId, ...uniqueMessageIds);
          if (result.changes !== uniqueMessageIds.length) {
            throw new Error("could not process every pending inbound message");
          }
        }
        const timestamp = now();
        db.prepare(`INSERT INTO message_cursors(chat_id,polled_through,updated_at) VALUES (?,?,?)
          ON CONFLICT(chat_id) DO UPDATE SET polled_through=excluded.polled_through, updated_at=excluded.updated_at
          WHERE message_cursors.polled_through < excluded.polled_through`).run(chatId, polledThrough, timestamp);
        const completed = db.prepare(`UPDATE automation_runs SET status='completed', completed_at=?, error=NULL, summary_json=?
          WHERE run_key=? AND claim_token=? AND status='running'`)
          .run(timestamp, JSON.stringify(summary ?? {}), runKey, claimToken);
        if (completed.changes !== 1) throw new Error("inbound finalization could not complete the current run");
        return mapRun(db.prepare("SELECT * FROM automation_runs WHERE run_key=?").get(runKey));
      });
    },

    upsertFeishuLink(link) {
      return withTransaction(db, () => {
        db.prepare(`INSERT INTO feishu_task_links
          (local_task_id,checkpoint_index,task_guid,parent_guid,snapshot_hash,updated_at) VALUES (?,?,?,?,?,?)
          ON CONFLICT(local_task_id,checkpoint_index) DO UPDATE SET task_guid=excluded.task_guid,
            parent_guid=excluded.parent_guid, snapshot_hash=excluded.snapshot_hash, updated_at=excluded.updated_at`)
          .run(link.localTaskId, link.checkpointIndex, link.taskGuid, link.parentGuid ?? null, link.snapshotHash ?? "", now());
        return mapLink(db.prepare(`SELECT * FROM feishu_task_links
          WHERE local_task_id=? AND checkpoint_index=?`).get(link.localTaskId, link.checkpointIndex));
      });
    },

    findFeishuLink(localTaskId, checkpointIndex) {
      return mapLink(db.prepare(`SELECT * FROM feishu_task_links
        WHERE local_task_id=? AND checkpoint_index=?`).get(localTaskId, checkpointIndex));
    },

    listFeishuLinks(localTaskId) {
      return db.prepare(`SELECT * FROM feishu_task_links WHERE local_task_id=? ORDER BY checkpoint_index`)
        .all(localTaskId).map(mapLink);
    },

    listAllFeishuLinks() {
      return db.prepare(`SELECT * FROM feishu_task_links ORDER BY local_task_id, checkpoint_index`)
        .all().map(mapLink);
    },

    listSentLegacyTaskGuids() {
      return db.prepare(`SELECT DISTINCT external_id FROM outbox
        WHERE kind='feishu_task_create' AND status='sent' AND external_id IS NOT NULL AND external_id <> ''
        ORDER BY external_id`).all().map((row) => row.external_id);
    },

    applyPersonalPlanLinkCutover({
      retainedLocalTaskId,
      obsoleteLocalTaskId,
      targetLocalTaskId,
      retainedLinks,
      obsoleteLinks,
    }) {
      if (new Set([retainedLocalTaskId, obsoleteLocalTaskId, targetLocalTaskId]).size !== 3) {
        throw new Error("cutover local task ids must be distinct");
      }
      return withTransaction(db, () => {
        const list = (localTaskId) => db.prepare(`SELECT * FROM feishu_task_links
          WHERE local_task_id=? ORDER BY checkpoint_index`).all(localTaskId).map(mapLink);
        const retainedCurrent = list(retainedLocalTaskId);
        const obsoleteCurrent = list(obsoleteLocalTaskId);
        const targetCurrent = list(targetLocalTaskId);

        if (sameLinkIdentity(targetCurrent, retainedLinks) && retainedCurrent.length === 0 && obsoleteCurrent.length === 0) {
          return { status: "already_applied", retainedLinks: targetCurrent.length, removedLinks: 0 };
        }
        if (targetCurrent.length !== 0
          || !sameLinkIdentity(retainedCurrent, retainedLinks)
          || !sameLinkIdentity(obsoleteCurrent, obsoleteLinks)) {
          throw new Error("cutover link identity changed");
        }

        const removed = db.prepare("DELETE FROM feishu_task_links WHERE local_task_id=?").run(obsoleteLocalTaskId).changes;
        if (removed !== obsoleteLinks.length) throw new Error("cutover link identity changed");
        const rebound = db.prepare(`UPDATE feishu_task_links SET local_task_id=?, updated_at=?
          WHERE local_task_id=?`).run(targetLocalTaskId, now(), retainedLocalTaskId).changes;
        if (rebound !== retainedLinks.length) throw new Error("cutover link identity changed");
        return { status: "applied", retainedLinks: rebound, removedLinks: removed };
      });
    },
  };
}

function sameLinkIdentity(actual, expected) {
  if (!Array.isArray(expected) || actual.length !== expected.length) return false;
  return actual.every((link, index) => {
    const candidate = expected[index];
    return link.checkpointIndex === candidate?.checkpointIndex
      && link.taskGuid === candidate?.taskGuid
      && (link.parentGuid || null) === (candidate?.parentGuid || null)
      && link.snapshotHash === (candidate?.snapshotHash || "");
  });
}
