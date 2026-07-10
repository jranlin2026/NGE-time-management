import { randomUUID } from "node:crypto";
import { readTasks } from "../lib/task-store.mjs";

const ALLOWED_FIELDS = new Map([
  ["title", "title"],
  ["project", "project"],
  ["quadrant", "quadrant"],
  ["importance", "importance"],
  ["urgency", "urgency"],
  ["dueAt", "due_at"],
  ["status", "status"],
  ["nextAction", "next_action"],
  ["doneDefinition", "done_definition"],
  ["estimateMinutes", "estimate_minutes"],
  ["blocker", "blocker"],
  ["procrastinationCount", "procrastination_count"],
  ["analysisStatus", "analysis_status"],
]);

export function createTaskRepository(db, deps = {}) {
  const now = deps.now || (() => new Date().toISOString());
  const id = deps.id || randomUUID;
  const selectById = db.prepare("SELECT * FROM tasks WHERE id = ?");
  const selectByMessage = db.prepare("SELECT * FROM tasks WHERE source_message_id = ?");

  function findById(taskId) {
    const row = selectById.get(taskId);
    return row ? mapTask(row) : null;
  }

  function create(input) {
    if (input.sourceMessageId) {
      const existing = selectByMessage.get(input.sourceMessageId);
      if (existing) return mapTask(existing);
    }
    if (input.id) {
      const existing = selectById.get(input.id);
      if (existing) return mapTask(existing);
    }

    const rawInput = clean(input.rawInput || input.title || "未命名任务");
    const timestamp = now();
    const taskId = input.id || id();
    db.prepare(`INSERT INTO tasks
      (id,title,project,raw_input,quadrant,importance,urgency,due_at,status,next_action,done_definition,
       estimate_minutes,blocker,procrastination_count,source_message_id,analysis_status,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      taskId,
      clean(input.title || rawInput).slice(0, 80),
      clean(input.project || "未归类"),
      rawInput,
      clean(input.quadrant || "重要不紧急"),
      clean(input.importance || "B"),
      clean(input.urgency || "medium"),
      input.dueAt || input.due || null,
      clean(input.status || "inbox"),
      clean(input.nextAction || input.next || "拆出一个 15 分钟动作"),
      clean(input.doneDefinition || input.done || "提交明确产出并反馈完成"),
      Number(input.estimateMinutes || input.estimate || 30),
      clean(input.blocker || ""),
      Number(input.procrastinationCount || 0),
      input.sourceMessageId || null,
      clean(input.analysisStatus || "pending"),
      input.createdAt || input.created || timestamp,
      timestamp,
    );
    return findById(taskId);
  }

  return {
    create,
    findById,
    findBySourceMessageId(messageId) {
      if (!messageId) return null;
      const row = selectByMessage.get(messageId);
      return row ? mapTask(row) : null;
    },
    listActive() {
      return db
        .prepare("SELECT * FROM tasks WHERE status NOT IN ('done','cancelled') ORDER BY created_at, id")
        .all()
        .map(mapTask);
    },
    listByStatus(...statuses) {
      if (!statuses.length) return [];
      const placeholders = statuses.map(() => "?").join(",");
      return db
        .prepare(`SELECT * FROM tasks WHERE status IN (${placeholders}) ORDER BY updated_at, id`)
        .all(...statuses)
        .map(mapTask);
    },
    findDoing() {
      const row = db.prepare("SELECT * FROM tasks WHERE status = 'doing' ORDER BY updated_at DESC LIMIT 1").get();
      return row ? mapTask(row) : null;
    },
    findByTitle(query, { includeDone = false } = {}) {
      const value = `%${clean(query)}%`;
      const condition = includeDone ? "" : "AND status NOT IN ('done','cancelled')";
      return db
        .prepare(`SELECT * FROM tasks WHERE title LIKE ? ${condition} ORDER BY updated_at DESC, id`)
        .all(value)
        .map(mapTask);
    },
    update(taskId, patch) {
      const entries = Object.entries(patch);
      for (const [key] of entries) {
        if (!ALLOWED_FIELDS.has(key)) throw new Error(`unsupported task field: ${key}`);
      }
      if (!entries.length) return findById(taskId);
      const clause = entries.map(([key]) => `${ALLOWED_FIELDS.get(key)} = ?`).join(", ");
      const result = db
        .prepare(`UPDATE tasks SET ${clause}, updated_at = ? WHERE id = ?`)
        .run(...entries.map(([, value]) => value), now(), taskId);
      if (!result.changes) throw new Error(`task not found: ${taskId}`);
      return findById(taskId);
    },
    async importMarkdown(kbDir) {
      const legacyTasks = await readTasks(kbDir);
      let imported = 0;
      for (const legacy of legacyTasks) {
        if (findById(legacy.id)) continue;
        create({
          ...legacy,
          rawInput: legacy.title,
          dueAt: legacy.due || null,
          status: legacy.status === "open" ? "ready" : legacy.status,
          analysisStatus: "legacy",
        });
        imported += 1;
      }
      return imported;
    },
  };
}

function mapTask(row) {
  return {
    id: row.id,
    title: row.title,
    project: row.project,
    rawInput: row.raw_input,
    quadrant: row.quadrant,
    importance: row.importance,
    urgency: row.urgency,
    dueAt: row.due_at,
    status: row.status,
    nextAction: row.next_action,
    doneDefinition: row.done_definition,
    estimateMinutes: row.estimate_minutes,
    blocker: row.blocker,
    procrastinationCount: row.procrastination_count,
    sourceMessageId: row.source_message_id,
    analysisStatus: row.analysis_status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function clean(value) {
  return String(value ?? "").replace(/\r?\n/g, " ").trim();
}
