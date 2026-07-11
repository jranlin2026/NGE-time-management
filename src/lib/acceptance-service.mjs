import { transitionTask } from "./task-state-machine.mjs";

export function createAcceptanceService(deps) {
  const { tasks, ops, analyzer, acceptances } = deps;
  const transaction = deps.transaction || ((fn) => fn());
  const fail = deps.failureInjector || (() => {});
  const now = () => deps.clock?.now?.().toISOString?.() || new Date().toISOString();

  async function request(task, { idempotencyKey = "" } = {}) {
    return transaction(() => {
      const transition = transitionTask({ task, action: "request_acceptance", at: now() });
      const saved = tasks.update(task.id, transition.patch);
      const acceptance = acceptances?.saveAcceptance({
        taskId: task.id, deliverableId: task.deliverableId || task.id, evidence: [], status: "pending",
        idempotencyKey: idempotencyKey || null,
      });
      ops.appendEvent({ taskId: task.id, kind: transition.event.kind, payload: { acceptanceId: acceptance?.id }, idempotencyKey: idempotencyKey || null });
      ops.enqueueOutbox({ kind: "evidence_request_card", payload: { task: saved }, idempotencyKey: idempotencyKey ? `outbox:${idempotencyKey}` : `evidence-request:${task.id}` });
      return acceptance;
    });
  }

  async function submit({ taskId, evidence = [], idempotencyKey = "" }) {
    const duplicate = existingSubmission(taskId, idempotencyKey);
    if (duplicate) return duplicate;
    requirePending(taskId);
    const taskForAnalysis = tasks.findById(taskId);
    const validation = validateEvidence(taskForAnalysis, evidence);
    const decision = validation || await safeAnalyze({ task: taskForAnalysis, evidence });

    return transaction(() => {
      const repeated = existingSubmission(taskId, idempotencyKey);
      if (repeated) return repeated;
      const { task, acceptance } = requirePending(taskId);
      const storedStatus = decision.status === "needs_user_confirmation" ? "pending" : decision.status;
      const stored = acceptances.decideAcceptance({
        acceptanceId: acceptance.id, status: storedStatus, explanation: decision.explanation,
        evidence, decidedAt: storedStatus === "pending" ? null : undefined,
      });
      fail("after_acceptance_write");

      let savedTask = task;
      if (decision.status === "accepted" || decision.status === "rejected") {
        const action = decision.status === "accepted" ? "accept" : "reject";
        const transition = transitionTask({ task, action, detail: decision.explanation || "", at: now() });
        savedTask = tasks.update(task.id, transition.patch);
        fail("after_task_write");
      } else {
        ops.enqueueOutbox({ kind: "acceptance_review_card", payload: { task, evidence, decision }, idempotencyKey: `acceptance-review:${acceptance.id}` });
        fail("after_outbox_write");
      }

      const result = { ...decision, acceptance: stored, task: savedTask };
      ops.appendEvent({ taskId, kind: "acceptance_evidence_submitted", payload: { evidence, decision, acceptanceId: stored.id }, idempotencyKey: idempotencyKey || null });
      fail("after_event_write");
      return result;
    });
  }

  async function decideByUser({ taskId, accepted, explanation = "", idempotencyKey = "" }) {
    const prior = existingSubmission(taskId, idempotencyKey);
    if (prior) return prior;
    return transaction(() => {
      const repeated = existingSubmission(taskId, idempotencyKey);
      if (repeated) return repeated;
      const { task, acceptance } = requirePending(taskId);
      const status = accepted ? "accepted" : "rejected";
      const stored = acceptances.decideAcceptance({ acceptanceId: acceptance.id, status, explanation });
      const transition = transitionTask({ task, action: accepted ? "accept" : "reject", detail: explanation, at: now() });
      const savedTask = tasks.update(task.id, transition.patch);
      const decision = { status, explanation, source: "user" };
      ops.appendEvent({ taskId, kind: "acceptance_evidence_submitted", payload: { decision, acceptanceId: stored.id }, idempotencyKey: idempotencyKey || null });
      return { ...decision, acceptance: stored, task: savedTask };
    });
  }

  function requirePending(taskId) {
    const task = tasks.findById(taskId);
    if (!task) throw new Error(`task not found: ${taskId}`);
    if (task.status !== "pending_acceptance") throw new Error(`task is not pending acceptance: ${taskId}`);
    const acceptance = acceptances?.findPendingAcceptanceByTask(taskId);
    if (!acceptance) throw new Error(`pending acceptance not found: ${taskId}`);
    return { task, acceptance };
  }

  function existingSubmission(taskId, key) {
    if (!key) return null;
    const event = ops.findEventByIdempotencyKey(key);
    if (!event) return null;
    const acceptance = event.payload?.acceptanceId ? acceptances?.getAcceptance(event.payload.acceptanceId) : null;
    return { ...(event.payload?.decision || {}), acceptance, task: tasks.findById(taskId), duplicate: true };
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

function validateEvidence(task, evidence) {
  if (!Array.isArray(evidence) || evidence.length === 0) return { status: "rejected", explanation: "未提交证据" };
  if (evidence.some((item) => item.type === "feishu_image" || item.type === "file_reference")) {
    return { status: "needs_user_confirmation", explanation: "图片或文件引用无法自动检查" };
  }
  const urlEvidence = evidence.filter((item) => item.type === "url");
  if (urlEvidence.some((item) => !/^https?:\/\/\S+$/i.test(item.value || ""))) return { status: "rejected", explanation: "链接格式无效" };
  const required = Number(String(task.doneDefinition || "").match(/(\d+)\s*(?:条|个|份|篇|张|次)/)?.[1] || 0);
  if (required && urlEvidence.length && urlEvidence.length < required) return { status: "rejected", explanation: `证据数量不足，需要 ${required} 项` };
  return null;
}
