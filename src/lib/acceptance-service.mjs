import { transitionTask } from "./task-state-machine.mjs";

export function createAcceptanceService(deps) {
  const { tasks, ops, analyzer } = deps;
  const acceptances = deps.acceptances;
  const transaction = deps.transaction || ((fn) => fn());
  const now = () => deps.clock?.now?.().toISOString?.() || new Date().toISOString();

  async function request(task, { idempotencyKey = "" } = {}) {
    return transaction(() => {
      const transition = transitionTask({ task, action: "request_acceptance", at: now() });
      const saved = tasks.update(task.id, transition.patch);
      const event = ops.appendEvent({ taskId: task.id, kind: transition.event.kind, payload: {}, idempotencyKey: idempotencyKey || null });
      const acceptance = acceptances?.saveAcceptance({
        taskId: task.id, deliverableId: task.deliverableId, evidence: [], status: "pending",
        idempotencyKey: idempotencyKey || null,
      });
      ops.enqueueOutbox({
        kind: "evidence_request_card",
        payload: { task: saved },
        idempotencyKey: idempotencyKey ? `outbox:${idempotencyKey}` : `evidence-request:${task.id}`,
      });
      return acceptance || { id: event.id, taskId: task.id, status: "pending", evidence: [] };
    });
  }

  async function submit({ taskId, evidence = [], idempotencyKey = "" }) {
    const prior = idempotencyKey ? ops.findEventByIdempotencyKey(idempotencyKey) : null;
    if (prior) return { ...(prior.payload?.decision || {}), task: tasks.findById(taskId), duplicate: true };
    const task = tasks.findById(taskId);
    if (!task) throw new Error(`task not found: ${taskId}`);
    let decision = deterministicDecision(task, evidence);
    if (!decision) decision = await safeAnalyze({ task, evidence });
    ops.appendEvent({ taskId, kind: "acceptance_evidence_submitted", payload: { evidence, decision }, idempotencyKey: idempotencyKey || null });
    const pending = acceptances?.findPendingAcceptanceByTask(taskId);
    if (pending) acceptances.decideAcceptance({
      acceptanceId: pending.id,
      status: decision.status === "needs_user_confirmation" ? "pending" : decision.status,
      explanation: decision.explanation,
      evidence,
      decidedAt: decision.status === "needs_user_confirmation" ? null : undefined,
    });
    if (decision.status === "accepted") return decide(task, "accept", decision);
    if (decision.status === "rejected") return decide(task, "reject", decision);
    ops.enqueueOutbox({ kind: "acceptance_review_card", payload: { task, evidence, decision }, idempotencyKey: `acceptance-review:${taskId}:${idempotencyKey || now()}` });
    return decision;
  }

  async function decideByUser({ taskId, accepted, explanation = "", idempotencyKey = "" }) {
    const prior = idempotencyKey ? ops.findEventByIdempotencyKey(idempotencyKey) : null;
    if (prior) return { status: prior.kind === "task_accepted" ? "accepted" : "rejected", task: tasks.findById(taskId), explanation: prior.payload?.explanation || "", duplicate: true };
    const task = tasks.findById(taskId);
    if (!task) throw new Error(`task not found: ${taskId}`);
    const status = accepted ? "accepted" : "rejected";
    const pending = acceptances?.findPendingAcceptanceByTask(taskId);
    if (pending) acceptances.decideAcceptance({ acceptanceId: pending.id, status, explanation });
    const result = decide(task, accepted ? "accept" : "reject", { explanation, source: "user" }, idempotencyKey);
    return { status, task: result.task, explanation };
  }

  function decide(task, action, decision, idempotencyKey = "") {
    return transaction(() => {
      const transition = transitionTask({ task, action, detail: decision.explanation || "", at: now() });
      const saved = tasks.update(task.id, transition.patch);
      ops.appendEvent({ taskId: task.id, kind: transition.event.kind, payload: decision, idempotencyKey: idempotencyKey || null });
      return { ...decision, status: action === "accept" ? "accepted" : "rejected", task: saved };
    });
  }

  async function safeAnalyze(input) {
    try {
      const result = await analyzer.analyzeAcceptance(input);
      return ["accepted", "rejected", "needs_user_confirmation"].includes(result?.status)
        ? result : { status: "needs_user_confirmation", explanation: "验收分析返回了无效状态" };
    } catch (error) {
      return { status: "needs_user_confirmation", explanation: String(error?.message || error) };
    }
  }

  return { request, submit, decideByUser };
}

function deterministicDecision(task, evidence) {
  if (!Array.isArray(evidence) || evidence.length === 0) return { status: "rejected", explanation: "未提交证据" };
  if (evidence.some((item) => item.type === "feishu_image" || item.type === "file_reference")) {
    return { status: "needs_user_confirmation", explanation: "图片或文件引用无法自动检查" };
  }
  const urls = evidence.filter((item) => item.type === "url" && /^https?:\/\/\S+$/i.test(item.value || ""));
  const required = Number(String(task.doneDefinition || task.completionStandard || "").match(/(\d+)\s*(?:条|个|份|篇|张|次)/)?.[1] || 0);
  if (required && urls.length && urls.length < required) return { status: "rejected", explanation: `证据数量不足，需要 ${required} 项` };
  if (urls.length && (!required || urls.length >= required)) return { status: "accepted", explanation: "链接证据满足可检查的完成标准" };
  return null;
}
