import { createHash, randomUUID } from "node:crypto";
import { dueCheckpointNodes, resolveCheckpointContext } from "./checkpoint-schedule.mjs";

const FIVE_MINUTES = 5 * 60_000;

export function createCheckpointRunner(deps) {
  requireDependencies(deps);

  return {
    async run({ now = deps.clock?.now?.() || new Date(), forcedNode, dryRun = false } = {}) {
      const instant = new Date(now);
      if (Number.isNaN(instant.getTime())) throw new Error("valid checkpoint time is required");
      const timezone = deps.config?.timezone || "Asia/Shanghai";
      const context = resolveCheckpointContext({ now: instant, timezone });
      const completedNodes = await deps.getCompletedNodes?.(context.workDate) || [];
      const nodes = forcedNode
        ? [validateNode(forcedNode)]
        : dueCheckpointNodes({ now: instant, timezone, completedNodes }).nodes;
      const summary = emptySummary(context.workDate, nodes, dryRun ? "dry_run" : "completed");
      if (dryRun) return summary;

      const owner = deps.owner?.() || randomUUID();
      const expiresAt = new Date(instant.getTime() + FIVE_MINUTES).toISOString();
      if (!await deps.runtime.claimLock({ owner, expiresAt })) return { status: "skipped", reason: "lock_held" };

      let activeRun = null;
      try {
        const chatId = await deps.resolveChatId();
        for (const node of nodes) {
          const runKey = `${context.workDate}:${node}`;
          const claim = await deps.runtime.claimRun({ runKey, workDate: context.workDate, node, expiresAt });
          if (!claim.claimed) continue;
          activeRun = { runKey, claimToken: claim.claimToken };

          const cursor = await deps.runtime.getMessageCursor(chatId);
          const polled = await deps.pollMessages({
            chatId,
            startTime: toEpochSeconds(cursor?.polledThrough),
            endTime: toEpochSeconds(instant.toISOString()),
          });
          const inbound = polled.map((message) => normalizeInbound(message, chatId));
          summary.messagesRead += inbound.length;
          await deps.runtime.recordInbound(inbound);
          const pending = await deps.runtime.listPendingInbound(chatId);
          const remoteProgress = await deps.taskSync.pullProgress({ date: context.workDate });
          const analysis = await deps.analyzer.analyzeCheckpointMessages({
            node, workDate: context.workDate, messages: pending, context: { remoteProgress },
          });
          const result = await deps.policy.apply({
            node, workDate: context.workDate, messages: pending, analysis, remoteProgress,
          });
          const schedule = result.schedule || { blocks: [] };
          await deps.taskSync.pushSchedule({ date: context.workDate, schedule });

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
              idempotencyKey: `private-summary:${context.workDate}:${node}:${scheduleVersion}:${messageDigest(pending)}`,
            });
            summary.repliesQueued += 1;
          }
          await deps.outboxWorker.flush();
          await deps.runtime.finalizeInbound({
            chatId,
            messageIds: pending.map((message) => message.messageId),
            runKey,
            claimToken: claim.claimToken,
            polledThrough: instant.toISOString(),
          });
          summary.messagesProcessed += pending.length;
          summary.tasksCreated += countActions(result.actions, "task_created");
          summary.tasksUpdated += countUpdated(result.actions);
          summary.reviewCreated += countActions(result.actions, "daily_review");
          await deps.runtime.completeRun(runKey, claim.claimToken, summary);
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

function requireDependencies(deps) {
  for (const key of ["runtime", "resolveChatId", "pollMessages", "taskSync", "analyzer", "policy", "ops", "outboxWorker"]) {
    if (!deps?.[key]) throw new Error(`checkpoint runner requires ${key}`);
  }
}

function validateNode(node) {
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

function countActions(actions = [], type) {
  return actions.filter((action) => action.type === type).length;
}

function countUpdated(actions = []) {
  return actions.filter((action) => ["checkpoint_completed", "parent_completed", "evidence_submitted", "task_feedback"].includes(action.type)).length;
}

function emptySummary(workDate, nodes, status) {
  return { status, workDate, nodes, messagesRead: 0, messagesProcessed: 0, tasksCreated: 0, tasksUpdated: 0, repliesQueued: 0, reviewCreated: 0, errors: [] };
}

function sanitizeError(error) {
  return String(error?.message || error)
    .replace(/(app_secret|token|webhook|authorization)\s*[:=]\s*[^\s,]+/gi, "$1=[redacted]")
    .slice(0, 500);
}
