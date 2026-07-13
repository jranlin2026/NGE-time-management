import { randomUUID } from "node:crypto";
import { withTransaction } from "./database.mjs";

export function createOperationsRepository(db, deps = {}) {
  const now = deps.now || (() => new Date().toISOString());
  const id = deps.id || randomUUID;

  function currentSchedule(date) {
    return db
      .prepare(`SELECT * FROM schedule_blocks
        WHERE schedule_date = ? AND replaced_by_version IS NULL ORDER BY starts_at, id`)
      .all(date)
      .map(mapBlock);
  }

  function scheduleAtVersion(date, version) {
    return db
      .prepare(`SELECT * FROM schedule_blocks
        WHERE schedule_date = ? AND version = ? ORDER BY starts_at, id`)
      .all(date, version)
      .map(mapBlock);
  }

  function scheduleFromEvent(row, { date, kind = null, payload = {} } = {}) {
    const event = mapEvent(row);
    const version = Number(event.payload?.version);
    const blockCount = Number(event.payload?.blockCount);
    const payloadMatches = Object.entries(payload).every(([key, value]) =>
      JSON.stringify(event.payload?.[key]) === JSON.stringify(value));
    const blocks = Number.isInteger(version) && version > 0 ? scheduleAtVersion(date, version) : [];
    if ((kind && event.kind !== kind)
      || event.payload?.date !== date
      || !Number.isInteger(version) || version < 1
      || !Number.isInteger(blockCount) || blockCount < 0
      || blocks.length !== blockCount
      || latestScheduleVersion(date) !== version
      || !payloadMatches) {
      throw new Error("idempotent schedule event does not match requested replan");
    }
    return { date, version, blocks, event, reused: true };
  }

  function latestScheduleVersion(date) {
    const blockVersion = Number(db
      .prepare("SELECT coalesce(max(version), 0) AS version FROM schedule_blocks WHERE schedule_date = ?")
      .get(date).version);
    const eventVersion = db.prepare(`SELECT payload_json FROM task_events
      WHERE kind IN ('schedule_replanned', 'daily_plan_created')`)
      .all()
      .reduce((maximum, row) => {
        const payload = JSON.parse(row.payload_json);
        const version = payload?.date === date ? Number(payload.version) : 0;
        return Number.isInteger(version) ? Math.max(maximum, version) : maximum;
      }, 0);
    return Math.max(blockVersion, eventVersion);
  }

  return {
    appendEvent({ taskId = null, kind, payload = {}, idempotencyKey = null, occurredAt = now() }) {
      const eventId = id();
      db.prepare(`INSERT OR IGNORE INTO task_events
        (id,task_id,kind,payload_json,idempotency_key,occurred_at) VALUES (?,?,?,?,?,?)`)
        .run(eventId, taskId, kind, JSON.stringify(payload), idempotencyKey, occurredAt);
      const row = idempotencyKey
        ? db.prepare("SELECT * FROM task_events WHERE idempotency_key = ?").get(idempotencyKey)
        : db.prepare("SELECT * FROM task_events WHERE id = ?").get(eventId);
      return mapEvent(row);
    },
    listEvents({ taskId = null, date = null, kind = null } = {}) {
      const clauses = [];
      const values = [];
      if (taskId) { clauses.push("task_id = ?"); values.push(taskId); }
      if (date) { clauses.push("substr(occurred_at, 1, 10) = ?"); values.push(date); }
      if (kind) { clauses.push("kind = ?"); values.push(kind); }
      const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
      return db
        .prepare(`SELECT * FROM task_events ${where} ORDER BY occurred_at, id`)
        .all(...values)
        .map(mapEvent);
    },
    findEventByIdempotencyKey(key) {
      if (!key) return null;
      const row = db.prepare("SELECT * FROM task_events WHERE idempotency_key = ?").get(key);
      return row ? mapEvent(row) : null;
    },
    findScheduleByIdempotencyKey(key, expected = {}) {
      if (!key) return null;
      const row = db.prepare("SELECT * FROM task_events WHERE idempotency_key = ?").get(key);
      return row ? scheduleFromEvent(row, expected) : null;
    },
    replaceSchedule({ date, blocks, event = null }) {
      return withTransaction(db, () => {
        if (event && (!event.kind || !event.idempotencyKey
          || !["schedule_replanned", "daily_plan_created"].includes(event.kind))) {
          throw new Error("valid schedule event kind and idempotency key are required");
        }
        if (event?.idempotencyKey) {
          const prior = db.prepare("SELECT * FROM task_events WHERE idempotency_key = ?").get(event.idempotencyKey);
          if (prior) return scheduleFromEvent(prior, {
            date,
            kind: event.kind,
            payload: { reason: event.payload?.reason },
          });
        }
        const version = latestScheduleVersion(date) + 1;
        db.prepare(`UPDATE schedule_blocks SET replaced_by_version = ?
          WHERE schedule_date = ? AND replaced_by_version IS NULL`).run(version, date);
        const insert = db.prepare(`INSERT INTO schedule_blocks
          (id,schedule_date,version,task_id,checkpoint_index,starts_at,ends_at,status,reason,created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?)`);
        for (const block of blocks) {
          insert.run(
            id(), date, version, block.taskId, block.checkpointIndex ?? null, block.startsAt, block.endsAt,
            block.status || "planned", block.reason, now(),
          );
        }
        let storedEvent = null;
        if (event) {
          const eventId = id();
          db.prepare(`INSERT INTO task_events
            (id,task_id,kind,payload_json,idempotency_key,occurred_at) VALUES (?,?,?,?,?,?)`)
            .run(eventId, event.taskId || null, event.kind, JSON.stringify({
              ...(event.payload || {}),
              date,
              version,
              blockCount: blocks.length,
            }), event.idempotencyKey, event.occurredAt || now());
          storedEvent = mapEvent(db.prepare("SELECT * FROM task_events WHERE id = ?").get(eventId));
        }
        return { date, version, blocks: scheduleAtVersion(date, version), event: storedEvent, reused: false };
      });
    },
    currentSchedule,
    listScheduleHistory(date) {
      return db
        .prepare("SELECT * FROM schedule_blocks WHERE schedule_date = ? ORDER BY version, starts_at, id")
        .all(date)
        .map(mapBlock);
    },
    enqueueReminder({ taskId = null, kind, dueAt, expiresAt = null, idempotencyKey }) {
      const reminderId = id();
      db.prepare(`INSERT OR IGNORE INTO reminders
        (id,task_id,kind,due_at,expires_at,status,attempt,idempotency_key,created_at)
        VALUES (?,?,?,?,?,'pending',0,?,?)`)
        .run(reminderId, taskId, kind, dueAt, expiresAt, idempotencyKey, now());
      const row = idempotencyKey
        ? db.prepare("SELECT * FROM reminders WHERE idempotency_key = ?").get(idempotencyKey)
        : db.prepare("SELECT * FROM reminders WHERE id = ?").get(reminderId);
      return mapReminder(row);
    },
    dueReminders(at) {
      return db
        .prepare(`SELECT * FROM reminders WHERE status = 'pending' AND due_at <= ?
          AND (expires_at IS NULL OR expires_at > ?) ORDER BY due_at, id`)
        .all(at, at)
        .map(mapReminder);
    },
    listReminders({ status = null, taskId = null } = {}) {
      const clauses = [];
      const values = [];
      if (status) { clauses.push("status = ?"); values.push(status); }
      if (taskId) { clauses.push("task_id = ?"); values.push(taskId); }
      const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
      return db.prepare(`SELECT * FROM reminders ${where} ORDER BY due_at, id`).all(...values).map(mapReminder);
    },
    updateReminder(reminderId, patch) {
      const allowed = new Map([
        ["status", "status"], ["dueAt", "due_at"], ["expiresAt", "expires_at"],
        ["attempt", "attempt"], ["firedAt", "fired_at"],
      ]);
      const entries = Object.entries(patch);
      for (const [key] of entries) if (!allowed.has(key)) throw new Error(`unsupported reminder field: ${key}`);
      if (entries.length) {
        const clause = entries.map(([key]) => `${allowed.get(key)} = ?`).join(", ");
        db.prepare(`UPDATE reminders SET ${clause} WHERE id = ?`).run(...entries.map(([, value]) => value), reminderId);
      }
      return mapReminder(db.prepare("SELECT * FROM reminders WHERE id = ?").get(reminderId));
    },
    cancelPendingReminders(taskId) {
      return db.prepare("UPDATE reminders SET status='cancelled' WHERE task_id=? AND status IN ('pending','processing')").run(taskId).changes;
    },
    cancelPendingRemindersExcept(taskId, idempotencyKeys = []) {
      const keys = [...new Set(idempotencyKeys.filter((key) => typeof key === "string" && key))];
      if (!keys.length) {
        return db.prepare("UPDATE reminders SET status='cancelled' WHERE task_id=? AND status IN ('pending','processing')")
          .run(taskId).changes;
      }
      const placeholders = keys.map(() => "?").join(",");
      return db.prepare(`UPDATE reminders SET status='cancelled'
        WHERE task_id=? AND status IN ('pending','processing')
        AND (idempotency_key IS NULL OR idempotency_key NOT IN (${placeholders}))`)
        .run(taskId, ...keys).changes;
    },
    expireStaleReminders(at) {
      return db.prepare(`UPDATE reminders SET status='expired'
        WHERE status='pending' AND expires_at IS NOT NULL AND expires_at <= ?`).run(at).changes;
    },
    enqueueOutbox({ kind, payload, idempotencyKey, nextAttemptAt = now() }) {
      const outboxId = id();
      db.prepare(`INSERT OR IGNORE INTO outbox
        (id,kind,payload_json,idempotency_key,status,attempts,next_attempt_at,created_at)
        VALUES (?,?,?,?,'pending',0,?,?)`)
        .run(outboxId, kind, JSON.stringify(payload), idempotencyKey, nextAttemptAt, now());
      const row = idempotencyKey
        ? db.prepare("SELECT * FROM outbox WHERE idempotency_key = ?").get(idempotencyKey)
        : db.prepare("SELECT * FROM outbox WHERE id = ?").get(outboxId);
      return mapOutbox(row);
    },
    dueOutbox(at, limit = 20) {
      return db
        .prepare(`SELECT * FROM outbox WHERE status='pending' AND next_attempt_at <= ?
          ORDER BY next_attempt_at, id LIMIT ?`)
        .all(at, limit)
        .map(mapOutbox);
    },
    listOutbox({ status = null } = {}) {
      const rows = status
        ? db.prepare("SELECT * FROM outbox WHERE status=? ORDER BY created_at, id").all(status)
        : db.prepare("SELECT * FROM outbox ORDER BY created_at, id").all();
      return rows.map(mapOutbox);
    },
    markOutboxSent(outboxId, externalId = "") {
      db.prepare(`UPDATE outbox SET status='sent', external_id=?, sent_at=?, last_error=NULL WHERE id=?`)
        .run(externalId, now(), outboxId);
    },
    markOutboxRetry(outboxId, error, nextAttemptAt) {
      const row = db.prepare("SELECT attempts FROM outbox WHERE id=?").get(outboxId);
      if (!row) throw new Error(`outbox not found: ${outboxId}`);
      const attempts = Number(row.attempts) + 1;
      const status = attempts >= 8 ? "failed" : "pending";
      db.prepare(`UPDATE outbox SET status=?, attempts=?, last_error=?, next_attempt_at=? WHERE id=?`)
        .run(status, attempts, String(error?.message || error), nextAttemptAt, outboxId);
    },
    saveReview({ date, summary, renderedText }) {
      db.prepare(`INSERT INTO daily_reviews(review_date,summary_json,rendered_text,created_at)
        VALUES (?,?,?,?) ON CONFLICT(review_date) DO UPDATE SET
        summary_json=excluded.summary_json, rendered_text=excluded.rendered_text, created_at=excluded.created_at`)
        .run(date, JSON.stringify(summary), renderedText, now());
      return { date, summary, renderedText };
    },
    getReview(date) {
      const row = db.prepare("SELECT * FROM daily_reviews WHERE review_date=?").get(date);
      return row ? mapReview(row) : null;
    },
    getSetting(key) {
      const row = db.prepare("SELECT value_json FROM settings WHERE key=?").get(key);
      return row ? JSON.parse(row.value_json) : null;
    },
    setSetting(key, value) {
      db.prepare(`INSERT INTO settings(key,value_json,updated_at) VALUES (?,?,?)
        ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at`)
        .run(key, JSON.stringify(value), now());
      return value;
    },
  };
}

function mapEvent(row) {
  return {
    id: row.id,
    taskId: row.task_id,
    kind: row.kind,
    payload: JSON.parse(row.payload_json),
    idempotencyKey: row.idempotency_key,
    occurredAt: row.occurred_at,
  };
}

function mapBlock(row) {
  return {
    id: row.id,
    date: row.schedule_date,
    version: row.version,
    taskId: row.task_id,
    checkpointIndex: row.checkpoint_index,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    status: row.status,
    reason: row.reason,
    replacedByVersion: row.replaced_by_version,
    createdAt: row.created_at,
  };
}

function mapReminder(row) {
  return {
    id: row.id,
    taskId: row.task_id,
    kind: row.kind,
    dueAt: row.due_at,
    expiresAt: row.expires_at,
    status: row.status,
    attempt: row.attempt,
    firedAt: row.fired_at,
    idempotencyKey: row.idempotency_key,
    createdAt: row.created_at,
  };
}

function mapOutbox(row) {
  return {
    id: row.id,
    kind: row.kind,
    payload: JSON.parse(row.payload_json),
    idempotencyKey: row.idempotency_key,
    status: row.status,
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
    externalId: row.external_id,
    lastError: row.last_error,
    createdAt: row.created_at,
    sentAt: row.sent_at,
  };
}

function mapReview(row) {
  return {
    date: row.review_date,
    summary: JSON.parse(row.summary_json),
    renderedText: row.rendered_text,
    createdAt: row.created_at,
  };
}
