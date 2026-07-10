const LEGAL = {
  inbox: new Set(["ready", "cancelled"]),
  open: new Set(["ready", "scheduled", "doing", "blocked", "deferred", "cancelled"]),
  ready: new Set(["scheduled", "doing", "deferred", "cancelled"]),
  scheduled: new Set(["doing", "blocked", "deferred", "cancelled"]),
  doing: new Set(["done", "blocked", "deferred", "cancelled"]),
  blocked: new Set(["doing", "deferred", "cancelled"]),
  deferred: new Set(["ready", "scheduled", "doing", "cancelled"]),
  done: new Set(["ready"]),
  cancelled: new Set([]),
};

const ACTIONS = {
  analyze: { target: "ready", kind: "task_analyzed" },
  schedule: { target: "scheduled", kind: "task_scheduled" },
  start: { target: "doing", kind: "task_started" },
  complete: { target: "done", kind: "task_completed" },
  block: { target: "blocked", kind: "task_blocked" },
  defer: { target: "deferred", kind: "task_deferred" },
  defer_30: { target: "deferred", kind: "task_deferred" },
  cancel: { target: "cancelled", kind: "task_cancelled" },
  restore: { target: "ready", kind: "task_restored" },
};

export function transitionTask({ task, action, detail = "", at = new Date().toISOString() }) {
  if (!task?.status) throw new Error("task status is required");

  if (action === "no_response_2") {
    if (["done", "cancelled"].includes(task.status)) {
      throw new Error(`illegal transition: ${task.status} via ${action}`);
    }
    return {
      patch: {
        status: task.status,
        procrastinationCount: Number(task.procrastinationCount || 0) + 1,
      },
      event: {
        kind: "procrastination_recorded",
        payload: { action, from: task.status, to: task.status, detail, at },
      },
    };
  }

  const definition = ACTIONS[action];
  if (!definition) throw new Error(`unknown task action: ${action}`);
  if (!LEGAL[task.status]?.has(definition.target)) {
    throw new Error(`illegal transition: ${task.status} -> ${definition.target} via ${action}`);
  }

  const patch = { status: definition.target };
  if (action === "block") {
    patch.blocker = String(detail || "").trim();
    patch.procrastinationCount = Number(task.procrastinationCount || 0);
  }
  if (["complete", "restore", "start"].includes(action)) patch.blocker = "";

  return {
    patch,
    event: {
      kind: definition.kind,
      payload: { action, from: task.status, to: definition.target, detail, at },
    },
  };
}

export function canTransition(status, action) {
  if (action === "no_response_2") return !["done", "cancelled"].includes(status);
  const target = ACTIONS[action]?.target;
  return Boolean(target && LEGAL[status]?.has(target));
}
