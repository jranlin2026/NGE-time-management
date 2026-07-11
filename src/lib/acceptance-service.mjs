import { transitionTask } from "./task-state-machine.mjs";

export function createAcceptanceService(deps) {
  const { tasks, ops, analyzer, acceptances, projectRepo } = deps;
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

    let projectWrite = null;
    if (decision.status === "accepted" && projectRepo && taskForAnalysis.projectId) {
      const acceptanceId = requirePending(taskId).acceptance.id;
      const operationKey = `acceptance-${acceptanceId}`;
      try {
        const project = await projectRepo.readProject(taskForAnalysis.projectId);
        projectWrite = await projectRepo.acceptDeliverable({
          projectId: taskForAnalysis.projectId,
          deliverableId: taskForAnalysis.deliverableId,
          evidence: summarizeEvidence(evidence),
          expectedHash: project.contentHash,
          operationKey,
        });
      } catch (error) {
        recordReconciliation({ task: taskForAnalysis, acceptanceId, decision, evidence, operationKey, error });
        throw error;
      }
    }

    try {
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
      let resultDecision = decision;
      if (decision.status === "accepted" || decision.status === "rejected") {
        const action = decision.status === "accepted" ? "accept" : "reject";
        const transition = transitionTask({ task, action, detail: decision.explanation || "", at: now() });
        savedTask = tasks.update(task.id, transition.patch);
        fail("after_task_write");
        ops.appendEvent({
          taskId,
          kind: transition.event.kind,
          payload: transition.event.payload,
          idempotencyKey: transitionEventKey(idempotencyKey, acceptance.id, decision.status),
        });
        fail("after_transition_event_write");
        if (decision.status === "rejected") {
          const reworkTaskId = `rework:${acceptance.id}`;
          tasks.create({
            id: reworkTaskId,
            projectId: task.projectId,
            milestoneId: task.milestoneId,
            deliverableId: task.deliverableId,
            requiresEvidence: true,
            title: `返工：${task.title}`,
            nextAction: decision.explanation || "根据验收意见继续完善",
            doneDefinition: task.doneDefinition,
            project: task.project,
            status: "ready",
          });
          resultDecision = { ...decision, reworkTaskId };
        }
        if (decision.status === "accepted" && projectWrite) {
          acceptances.saveSyncState({
            projectId: task.projectId,
            filePath: projectWrite.filePath,
            contentHash: projectWrite.contentHash,
            lastWrittenVersion: projectWrite.projectProgress,
            lastError: null,
          });
          ops.enqueueOutbox({
            kind: "project_progress_card",
            payload: progressPayload(task, projectWrite, evidence),
            idempotencyKey: `project-progress:${acceptance.id}`,
          });
        }
      } else {
        ops.enqueueOutbox({ kind: "acceptance_review_card", payload: { task, evidence, decision }, idempotencyKey: `acceptance-review:${acceptance.id}` });
        fail("after_outbox_write");
      }

      const result = { ...resultDecision, acceptance: stored, task: savedTask };
      ops.appendEvent({ taskId, kind: "acceptance_evidence_submitted", payload: { evidence, decision: resultDecision, acceptanceId: stored.id }, idempotencyKey: submissionEventKey(idempotencyKey, acceptance.id, decision.status) });
      fail("after_event_write");
      return { ...result, acceptanceId: stored.id };
      });
    } catch (error) {
      if (projectWrite) {
        const acceptanceId = requirePending(taskId).acceptance.id;
        recordReconciliation({ task: taskForAnalysis, acceptanceId, decision, evidence, operationKey: `acceptance-${acceptanceId}`, projectWrite, error });
      }
      throw error;
    }
  }

  async function decideByUser({ taskId, acceptanceId, accepted, decision, explanation = "", idempotencyKey = "" }) {
    if (decision !== undefined && !["accepted", "rejected"].includes(decision)) {
      throw new Error(`invalid acceptance decision: ${decision}`);
    }
    const selectedAcceptance = acceptanceId ? acceptances.getAcceptance(acceptanceId) : null;
    taskId = taskId || selectedAcceptance?.taskId;
    const isAccepted = decision ? decision === "accepted" : Boolean(accepted);
    const prior = existingSubmission(taskId, idempotencyKey);
    if (prior) return prior;
    const pendingState = requirePending(taskId);
    if (acceptanceId && pendingState.acceptance.id !== acceptanceId) throw new Error(`acceptance is not pending: ${acceptanceId}`);
    let projectWrite = null;
    const acceptedDecision = { status: "accepted", explanation, source: "user" };
    const recoveryEvidence = pendingState.acceptance.evidence;
    const operationKey = `acceptance-${pendingState.acceptance.id}`;
    if (isAccepted && projectRepo && pendingState.task.projectId) {
      try {
        const project = await projectRepo.readProject(pendingState.task.projectId);
        projectWrite = await projectRepo.acceptDeliverable({
          projectId: pendingState.task.projectId,
          deliverableId: pendingState.task.deliverableId,
          evidence: summarizeEvidence(recoveryEvidence),
          expectedHash: project.contentHash,
          operationKey,
        });
      } catch (error) {
        recordReconciliation({ task: pendingState.task, acceptanceId: pendingState.acceptance.id, decision: acceptedDecision, evidence: recoveryEvidence, operationKey, error });
        throw error;
      }
    }
    try {
      return transaction(() => {
      const repeated = existingSubmission(taskId, idempotencyKey);
      if (repeated) return repeated;
      const { task, acceptance } = requirePending(taskId);
      const status = isAccepted ? "accepted" : "rejected";
      const stored = acceptances.decideAcceptance({ acceptanceId: acceptance.id, status, explanation });
      const transition = transitionTask({ task, action: isAccepted ? "accept" : "reject", detail: explanation, at: now() });
      const savedTask = tasks.update(task.id, transition.patch);
      let storedDecision = { status, explanation, source: "user" };
      if (!isAccepted) {
        const reworkTaskId = `rework:${acceptance.id}`;
        tasks.create({
          id: reworkTaskId, projectId: task.projectId, milestoneId: task.milestoneId,
          deliverableId: task.deliverableId, requiresEvidence: true,
          title: `返工：${task.title}`, nextAction: explanation || "根据验收意见继续完善",
          doneDefinition: task.doneDefinition, project: task.project, status: "ready",
        });
        storedDecision = { ...storedDecision, reworkTaskId };
      }
      ops.appendEvent({ taskId, kind: transition.event.kind, payload: transition.event.payload, idempotencyKey: transitionEventKey(idempotencyKey, acceptance.id, status) });
      if (isAccepted && projectWrite) {
        acceptances.saveSyncState({ projectId: task.projectId, filePath: projectWrite.filePath, contentHash: projectWrite.contentHash, lastWrittenVersion: projectWrite.projectProgress, lastError: null });
        ops.enqueueOutbox({ kind: "project_progress_card", payload: progressPayload(task, projectWrite, acceptance.evidence), idempotencyKey: `project-progress:${acceptance.id}` });
      }
      ops.appendEvent({ taskId, kind: "acceptance_evidence_submitted", payload: { decision: storedDecision, acceptanceId: stored.id }, idempotencyKey: submissionEventKey(idempotencyKey, acceptance.id, status) });
      return { ...storedDecision, acceptance: stored, acceptanceId: stored.id, task: savedTask };
      });
    } catch (error) {
      if (projectWrite) {
        recordReconciliation({ task: pendingState.task, acceptanceId: pendingState.acceptance.id, decision: acceptedDecision, evidence: recoveryEvidence, operationKey, projectWrite, error });
      }
      throw error;
    }
  }

  async function resumeAcceptedWriteback(input) {
    const payload = input?.payload || input;
    if (payload?.decision !== "accepted") throw new Error("reconciliation is not an accepted writeback");
    for (const field of ["acceptanceId", "taskId", "projectId", "deliverableId", "operationKey"]) {
      if (!payload[field]) throw new Error(`reconciliation is missing ${field}`);
    }
    if (!Array.isArray(payload.evidence) || payload.evidence.length === 0) throw new Error("reconciliation is missing evidence");
    if (payload.operationKey !== `acceptance-${payload.acceptanceId}`) throw new Error("reconciliation operation identity is invalid");
    const task = tasks.findById(payload.taskId);
    const storedAcceptance = acceptances.getAcceptance(payload.acceptanceId);
    if (!task || task.projectId !== payload.projectId || task.deliverableId !== payload.deliverableId) {
      throw new Error("reconciliation task identity does not match");
    }
    if (!storedAcceptance || storedAcceptance.taskId !== task.id || storedAcceptance.deliverableId !== task.deliverableId) {
      throw new Error("reconciliation acceptance identity does not match");
    }
    if (JSON.stringify(storedAcceptance.evidence) !== JSON.stringify(payload.evidence)) {
      throw new Error("reconciliation evidence does not match durable acceptance");
    }
    if (task.status === "done" && storedAcceptance.status === "accepted") {
      return { status: "accepted", task, acceptance: storedAcceptance, acceptanceId: storedAcceptance.id, duplicate: true };
    }
    if (task.status !== "pending_acceptance" || storedAcceptance.status !== "pending") {
      throw new Error("reconciliation state is not pending");
    }

    const project = await projectRepo.readProject(task.projectId);
    const projectWrite = await projectRepo.acceptDeliverable({
      projectId: task.projectId,
      deliverableId: task.deliverableId,
      evidence: summarizeEvidence(payload.evidence),
      expectedHash: project.contentHash,
      operationKey: payload.operationKey,
    });
    return transaction(() => {
      const currentTask = tasks.findById(task.id);
      const currentAcceptance = acceptances.getAcceptance(storedAcceptance.id);
      if (currentTask.status === "done" && currentAcceptance.status === "accepted") {
        return { status: "accepted", task: currentTask, acceptance: currentAcceptance, acceptanceId: currentAcceptance.id, duplicate: true };
      }
      if (currentTask.status !== "pending_acceptance" || currentAcceptance.status !== "pending") {
        throw new Error("reconciliation state changed before finalize");
      }
      const explanation = payload.explanation || "恢复已确认的项目写回";
      const stored = acceptances.decideAcceptance({
        acceptanceId: currentAcceptance.id, status: "accepted", explanation, evidence: payload.evidence,
      });
      const transition = transitionTask({ task: currentTask, action: "accept", detail: explanation, at: now() });
      const savedTask = tasks.update(currentTask.id, transition.patch);
      ops.appendEvent({
        taskId: currentTask.id, kind: transition.event.kind, payload: transition.event.payload,
        idempotencyKey: `acceptance:${currentAcceptance.id}:transition:accepted`,
      });
      acceptances.saveSyncState({
        projectId: currentTask.projectId, filePath: projectWrite.filePath, contentHash: projectWrite.contentHash,
        lastWrittenVersion: projectWrite.projectProgress, lastError: null,
      });
      ops.enqueueOutbox({
        kind: "project_progress_card", payload: progressPayload(currentTask, projectWrite, payload.evidence),
        idempotencyKey: `project-progress:${currentAcceptance.id}`,
      });
      const decision = { status: "accepted", explanation, source: payload.source || "recovery" };
      ops.appendEvent({
        taskId: currentTask.id, kind: "acceptance_evidence_submitted",
        payload: { evidence: payload.evidence, decision, acceptanceId: stored.id },
        idempotencyKey: `acceptance:${currentAcceptance.id}:submission:accepted`,
      });
      return { ...decision, acceptance: stored, acceptanceId: stored.id, task: savedTask };
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
    return { ...(event.payload?.decision || {}), acceptance, acceptanceId: acceptance?.id, task: tasks.findById(taskId), duplicate: true };
  }

  function recordReconciliation({ task, acceptanceId, decision, evidence, operationKey, projectWrite = null, error }) {
    ops.appendEvent({
      taskId: task.id,
      kind: "project_sync_reconciliation_required",
      payload: {
        decision: decision?.status,
        explanation: decision?.explanation || "",
        source: decision?.source || "analyzer",
        taskId: task.id,
        projectId: task.projectId,
        deliverableId: task.deliverableId,
        acceptanceId,
        evidence,
        operationKey,
        receiptPath: projectWrite?.changeLogPath || null,
        contentHash: projectWrite?.contentHash || null,
        beforeProgress: projectWrite?.beforeProgress ?? null,
        afterProgress: projectWrite?.projectProgress ?? null,
        errorCode: error?.code || null,
        error: String(error?.message || error),
      },
      idempotencyKey: `project-sync-reconcile:${acceptanceId}`,
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

  return { request, submit, decideByUser, resumeAcceptedWriteback };
}

function findDeliverable(project, deliverableId) {
  return project.milestones?.flatMap((item) => item.deliverables || []).find((item) => item.id === deliverableId);
}

function summarizeEvidence(evidence) {
  return evidence.map((item) => item.value).filter(Boolean).join("｜");
}

function progressPayload(task, write, evidence) {
  const project = write;
  const deliverable = findDeliverable(project, task.deliverableId);
  return {
    taskId: task.id,
    projectId: task.projectId,
    deliverable: { id: task.deliverableId, name: deliverable?.name || task.title },
    evidence,
    beforeProgress: write.beforeProgress,
    afterProgress: write.projectProgress,
    nextCandidate: String(project.nextCandidates || "").split(/\r?\n/).find((line) => line.trim()) || "待确认",
  };
}

function submissionEventKey(inputKey, acceptanceId, status) {
  return inputKey || `acceptance:${acceptanceId}:submission:${status}`;
}

function transitionEventKey(inputKey, acceptanceId, status) {
  return inputKey ? `${inputKey}:transition` : `acceptance:${acceptanceId}:transition:${status}`;
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
