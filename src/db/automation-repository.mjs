import { withTransaction } from "./database.mjs";
import { randomUUID } from "node:crypto";

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

function sanitizeError(error) {
  const text = error instanceof Error ? error.message : String(error ?? "");
  return text.slice(0, 500);
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

    finalizeInbound({ chatId, messageIds, runKey, claimToken, polledThrough }) {
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
        return mapCursor(db.prepare("SELECT * FROM message_cursors WHERE chat_id=?").get(chatId));
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
  };
}
