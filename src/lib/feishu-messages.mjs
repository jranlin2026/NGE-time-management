import { feishuRequest } from "./feishu-openapi.mjs";
import { createTask, updateTask } from "./feishu-tasks.mjs";

const TEXT_ACTIONS = [
  [/^开始[:：]\s*(.+)$/, "start"],
  [/^完成[:：]\s*(.+)$/, "complete"],
  [/^卡住[:：]\s*(.+)$/, "block"],
  [/^推迟\s*30\s*分钟[:：]\s*(.+)$/, "defer_30"],
  [/^恢复[:：]\s*(.+)$/, "restore"],
];

export function extractCardAction(input = {}) {
  const event = input.event || input;
  const action = event.action || input.action || {};
  const value = action.value || action.form_value || {};
  const eventId = input.header?.event_id || input.event_id || event.event_id || input.token || "";
  const actorId = event.operator?.open_id || event.operator?.operator_id?.open_id || event.operator_id?.open_id || input.operator?.open_id || "";
  if (!value.action) return null;
  return { value, eventId, ...(actorId ? { actorId } : {}) };
}

export function normalizeManagerAction(input) {
  if (typeof input === "string") {
    const text = input.trim();
    const weeklyAdjustment = text.match(/^调整周计划\s*[｜|]\s*(.+)$/);
    if (weeklyAdjustment) {
      return { action: "adjust_weekly_plan", taskId: "", query: "", detail: weeklyAdjustment[1].trim(), idempotencyKey: "" };
    }
    const deferWithReason = text.match(/^推迟\s*30\s*分钟[:：]\s*(.+?)\s*[｜|]\s*(.+)$/);
    if (deferWithReason) {
      return { action: "defer_30", taskId: "", query: deferWithReason[1].trim(), detail: deferWithReason[2].trim(), idempotencyKey: "" };
    }
    for (const [pattern, action] of TEXT_ACTIONS) {
      const match = text.match(pattern);
      if (!match) continue;
      const content = match[1].trim();
      return { action, taskId: "", query: content, detail: action === "block" ? content : "", idempotencyKey: "" };
    }
    return null;
  }

  const value = input?.value || input?.action?.value || {};
  if (!value.action) return null;
  return {
    action: value.action,
    taskId: value.taskId || "",
    ...(value.weekId === undefined ? {} : { weekId: String(value.weekId).trim() }),
    ...(value.version === undefined ? {} : { version: Number(value.version) }),
    ...(value.projects === undefined ? {} : { projects: value.projects }),
    ...(value.checkpointIndex === undefined ? {} : { checkpointIndex: value.checkpointIndex }),
    query: value.query || "",
    detail: value.detail || "",
    idempotencyKey: input.eventId ? `card:${input.eventId}` : "",
    ...(input.actorId ? { actorId: input.actorId } : {}),
  };
}

export async function sendFeishuMessage(config, payload) {
  const receiveId = payload.receiveId || config.feishuReceiveId;
  const receiveIdType = payload.receiveIdType || config.feishuReceiveIdType || "open_id";
  if (!receiveId) throw new Error("missing FEISHU_RECEIVE_ID");
  const isCard = payload.kind === "card";
  const body = {
    receive_id: receiveId,
    msg_type: isCard ? "interactive" : "text",
    content: JSON.stringify(isCard ? payload.card : { text: payload.text }),
  };
  const response = await feishuRequest(
    config,
    `/im/v1/messages?receive_id_type=${encodeURIComponent(receiveIdType)}`,
    { method: "POST", body },
  );
  return {
    externalId: response?.data?.message_id || "",
    chatId: response?.data?.chat_id || "",
  };
}

export async function syncFeishuTask(config, operation) {
  if (operation.action === "create") {
    const response = await createTask(config, operation.task);
    return { externalId: response?.data?.task?.guid || response?.data?.guid || "" };
  }
  if (operation.action === "update") {
    const response = await updateTask(config, operation.taskGuid, operation.patch);
    return { externalId: response?.data?.task?.guid || operation.taskGuid };
  }
  throw new Error(`unsupported Feishu task operation: ${operation.action}`);
}
