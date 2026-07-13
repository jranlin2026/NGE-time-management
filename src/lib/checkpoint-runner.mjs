import { createHash, randomUUID } from "node:crypto";
import { dueCheckpointNodes, resolveCheckpointContext } from "./checkpoint-schedule.mjs";
import { sanitizeError } from "./sanitize-error.mjs";
import { zonedDateTimeToUtc } from "./schedule-engine.mjs";

const FIVE_MINUTES = 5 * 60_000;

export function createCheckpointRunner(deps) {
  requireDependencies(deps);

  return {
    async run({ now = deps.clock?.now?.() || new Date(), forcedNode, dryRun = false } = {}) {
      const instant = new Date(now);
      if (Number.isNaN(instant.getTime())) throw new Error("valid checkpoint time is required");
      const timezone = deps.config?.timezone || "Asia/Shanghai";
      const context = resolveCheckpointContext({ now: instant, timezone });
      if (dryRun) {
        const nodes = forcedNode
          ? [validateCheckpointNode(forcedNode)]
          : dueCheckpointNodes({ now: instant, timezone, completedNodes: [] }).nodes;
        return emptySummary(context.workDate, nodes, "dry_run");
      }

      const owner = deps.owner?.() || randomUUID();
      const executionNow = new Date(deps.clock?.now?.() || new Date());
      const expiresAt = new Date(executionNow.getTime() + FIVE_MINUTES).toISOString();
      if (!await deps.runtime.claimLock({ owner, expiresAt })) return { status: "skipped", reason: "lock_held" };

      let activeRun = null;
      let summary = emptySummary(context.workDate, [], "completed");
      try {
        await deps.reconcileProjectWrites?.();
        const completedNodes = await deps.getCompletedNodes?.(context.workDate) || [];
        const refs = forcedNode
          ? [{ node: validateCheckpointNode(forcedNode), workDate: context.workDate, pollThrough: instant.toISOString() }]
          : executionRefs({ instant, timezone, context, completedNodes });
        summary = emptySummary(context.workDate, refs.map((ref) => ref.node), "completed");
        const chatId = await deps.resolveChatId();
        for (const ref of refs) {
          const { node, workDate, pollThrough } = ref;
          const runKey = `${workDate}:${node}`;
          const claim = await deps.runtime.claimRun({ runKey, workDate, node, expiresAt });
          if (!claim.claimed) continue;
          activeRun = { runKey, claimToken: claim.claimToken };

          const cursor = await deps.runtime.getMessageCursor(chatId);
          const polled = await deps.pollMessages({
            chatId,
            startTime: toEpochSeconds(cursor?.polledThrough),
            endTime: toEpochSeconds(pollThrough),
          });
          const inbound = polled.map((message) => normalizeInbound(message, chatId));
          summary.messagesRead += inbound.length;
          await deps.runtime.recordInbound(inbound);
          const pending = await deps.runtime.listPendingInbound(chatId, { through: pollThrough });
          const remoteProgress = await deps.taskSync.pullProgress({ date: workDate });
          let storedSnapshot = await deps.runtime.loadRunAnalysis?.(runKey);
          let snapshot = normalizeAnalysisSnapshot(storedSnapshot);
          let analysisBatch = snapshot
            ? filterAnalysisBatch(pending, snapshot.messageIds)
            : pending;
          let analysisContext = await deps.buildAnalysisContext?.({
            node, workDate, messages: analysisBatch, remoteProgress,
          }) || {};
          let analysis = snapshot?.analysis;
          if (!snapshot) {
            analysis = await deps.analyzer.analyzeCheckpointMessages({
              node, workDate, messages: analysisBatch, context: { ...analysisContext, remoteProgress },
            });
            const proposedSnapshot = { messageIds: sortedMessageIds(analysisBatch), analysis };
            storedSnapshot = await deps.runtime.saveRunAnalysis?.(runKey, claim.claimToken, proposedSnapshot) || proposedSnapshot;
            snapshot = normalizeAnalysisSnapshot(storedSnapshot);
            analysis = snapshot.analysis;
            analysisBatch = filterAnalysisBatch(pending, snapshot.messageIds);
            analysisContext = await deps.buildAnalysisContext?.({
              node, workDate, messages: analysisBatch, remoteProgress,
            }) || analysisContext;
          }
          const progress = await deps.policy.reconcileRemoteProgress({
            node, workDate, messages: analysisBatch, remoteProgress,
          });
          const result = await deps.policy.apply({
            node, workDate, messages: analysisBatch, analysis, remoteProgress,
            remoteProgressApplied: true,
            prelude: progress,
          });
          const schedule = result.schedule || analysisContext.schedule || { blocks: [] };
          try {
            await deps.taskSync.pushSchedule({ date: workDate, schedule });
          } catch (syncError) {
            try {
              if (deps.config.managerUserId) {
                await deps.ops.enqueueOutbox({
                  kind: "private_checkpoint_summary",
                  payload: {
                    text: "计划已经生成，但飞书任务同步失败。\n当前不要按旧任务执行；系统将在下一节点重试，并在同步完成后发送最新版执行令。",
                    receiveId: deps.config.managerUserId,
                    receiveIdType: "open_id",
                  },
                  idempotencyKey: `private-sync-failure:${workDate}:${node}`,
                });
                await deps.outboxWorker.flush({ throwOnFailure: true });
              }
            } catch {
              // The original sync failure controls retry semantics.
            }
            throw syncError;
          }

          if (result.replyRequired && result.reply) {
            if (!deps.config.managerUserId) throw new Error("private checkpoint summary requires owner open_id");
            const scheduleVersion = schedule.version ?? deps.config?.scheduleVersion ?? 0;
            await deps.ops.enqueueOutbox({
              kind: "private_checkpoint_summary",
              payload: {
                text: result.reply,
                receiveId: deps.config.managerUserId,
                receiveIdType: "open_id",
              },
              idempotencyKey: `private-summary:${workDate}:${node}:${scheduleVersion}:${messageDigest(analysisBatch)}`,
            });
            summary.repliesQueued += 1;
          }
          await deps.outboxWorker.flush({ throwOnFailure: true });
          summary.messagesProcessed += analysisBatch.length;
          summary.tasksCreated += countActions(result.actions, "task_created");
          summary.tasksUpdated += countUpdated(result.actions);
          summary.reviewCreated += countActions(result.actions, "daily_review");
          await deps.runtime.finalizeInbound({
            chatId,
            messageIds: analysisBatch.map((message) => message.messageId),
            runKey,
            claimToken: claim.claimToken,
            polledThrough: pollThrough,
            summary,
          });
          activeRun = null;
        }
        return summary;
      } catch (error) {
        summary.errors.push(sanitizeError(error));
        if (activeRun) await deps.runtime.failRun(activeRun.runKey, activeRun.claimToken, sanitizeError(error));
        throw error;
      } finally {
        await deps.runtime.releaseLock(owner);
      }
    },
  };
}

function executionRefs({ instant, timezone, context, completedNodes }) {
  const due = dueCheckpointNodes({ now: instant, timezone, completedNodes }).nodes;
  const previousDate = addDays(context.workDate, -1);
  return due.map((node) => {
    const priorReview = node === "24:00" && context.currentNode !== "24:00";
    const workDate = priorReview ? previousDate : context.workDate;
    const prerequisite = node !== context.currentNode;
    const pollThrough = prerequisite
      ? zonedDateTimeToUtc(workDate, node, timezone).toISOString()
      : instant.toISOString();
    return { node, workDate, pollThrough };
  });
}

function addDays(date, amount) {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + amount)).toISOString().slice(0, 10);
}

function requireDependencies(deps) {
  for (const key of ["runtime", "resolveChatId", "pollMessages", "taskSync", "analyzer", "policy", "ops", "outboxWorker"]) {
    if (!deps?.[key]) throw new Error(`checkpoint runner requires ${key}`);
  }
}

export function validateCheckpointNode(node) {
  if (!["08:00", "09:00", "12:00", "15:00", "18:00", "21:00", "24:00"].includes(node)) {
    throw new Error(`unsupported checkpoint node: ${node}`);
  }
  return node;
}

function normalizeInbound(message, chatId) {
  return {
    messageId: message.messageId,
    chatId: message.chatId || chatId,
    senderId: message.senderId || "",
    messageType: message.messageType || "",
    content: message.content || {},
    createdAt: normalizeMessageTime(message.createdAt || message.createTime),
  };
}

function normalizeMessageTime(value) {
  if (/^\d+$/.test(String(value || ""))) return new Date(Number(value) * 1000).toISOString();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? new Date(0).toISOString() : parsed.toISOString();
}

function toEpochSeconds(value) {
  if (!value) return undefined;
  return Math.floor(new Date(value).getTime() / 1000);
}

function messageDigest(messages) {
  return createHash("sha256").update(JSON.stringify(messages.map((message) => ({
    id: message.messageId, content: message.content,
  })))).digest("hex");
}

function normalizeAnalysisSnapshot(stored) {
  if (!stored) return null;
  const analysis = stored.analysis && typeof stored.analysis === "object" ? stored.analysis : stored;
  const messageIds = Array.isArray(stored.messageIds)
    ? [...new Set(stored.messageIds.filter((id) => typeof id === "string" && id))].sort()
    : analysisMessageIds(analysis);
  return { messageIds, analysis };
}

function analysisMessageIds(analysis) {
  return [...new Set((analysis?.items || []).flatMap((item) =>
    Array.isArray(item?.messageIds) ? item.messageIds : [],
  ).filter((id) => typeof id === "string" && id))].sort();
}

function sortedMessageIds(messages) {
  return [...new Set(messages.map((message) => message.messageId).filter(Boolean))].sort();
}

function filterAnalysisBatch(pending, messageIds) {
  const accepted = new Set(messageIds);
  return pending.filter((message) => accepted.has(message.messageId));
}

function countActions(actions = [], type) {
  return actions.filter((action) => action.type === type).length;
}

function countUpdated(actions = []) {
  return actions.filter((action) => ["checkpoint_completed", "parent_completed", "evidence_submitted", "task_feedback"].includes(action.type)).length;
}

function emptySummary(workDate, nodes, status) {
  return { status, workDate, nodes, messagesRead: 0, messagesProcessed: 0, tasksCreated: 0, tasksUpdated: 0, repliesQueued: 0, reviewCreated: 0, errors: [] };
}
