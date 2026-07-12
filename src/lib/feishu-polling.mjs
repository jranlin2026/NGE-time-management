import { sendFeishuMessage } from "./feishu-messages.mjs";
import { feishuRequest } from "./feishu-openapi.mjs";

const P2P_CHAT_SETTING = "feishu_p2p_chat_id";

export function normalizePolledMessage(item = {}) {
  const parsed = parseBodyContent(item.body?.content);
  const messageType = item.msg_type || "";
  let content;
  if (messageType === "text") {
    content = { text: typeof parsed.text === "string" ? parsed.text : "" };
  } else if (messageType === "image") {
    content = {
      imageKey: typeof parsed.image_key === "string" ? parsed.image_key : "",
      unavailableForTextAnalysis: true,
    };
  } else {
    content = { unavailableForTextAnalysis: true };
  }

  return {
    messageId: item.message_id || "",
    senderId: item.sender?.id || "",
    senderType: item.sender?.sender_type || "",
    messageType,
    createTime: item.create_time || "",
    content,
  };
}

export async function listConversationMessages(config, { chatId, startTime, endTime }, dependencies = {}) {
  const request = dependencies.request || feishuRequest;
  const messages = [];
  let pageToken = "";

  do {
    const params = new URLSearchParams({
      container_id_type: "chat",
      container_id: chatId,
      sort_type: "ByCreateTimeAsc",
      page_size: "50",
    });
    if (startTime) params.set("start_time", String(startTime));
    if (endTime) params.set("end_time", String(endTime));
    if (pageToken) params.set("page_token", pageToken);

    const response = await request(config, `/im/v1/messages?${params}`);
    const data = response?.data || {};
    for (const item of data.items || []) {
      if (item?.sender?.sender_type !== "user") continue;
      if (item?.sender?.id !== config.managerUserId) continue;
      messages.push(normalizePolledMessage(item));
    }

    if (data.has_more !== true) break;
    if (!data.page_token) throw new Error("Feishu message history has_more without page_token");
    pageToken = data.page_token;
  } while (true);

  return messages;
}

export async function resolveDirectChatId(config, ops, dependencies = {}) {
  if (config.feishuP2pChatId) return config.feishuP2pChatId;

  const persisted = ops.getSetting(P2P_CHAT_SETTING);
  if (typeof persisted === "string" && persisted) return persisted;

  const send = dependencies.send || sendFeishuMessage;
  const result = await send(config, {
    kind: "text",
    text: "时间管理助手已建立直接会话。",
    receiveId: config.feishuReceiveId,
    receiveIdType: config.feishuReceiveIdType,
  });
  if (!result?.chatId) throw new Error("bootstrap Feishu DM did not return chat_id");
  ops.setSetting(P2P_CHAT_SETTING, result.chatId);
  return result.chatId;
}

function parseBodyContent(content) {
  if (typeof content !== "string") return {};
  try {
    const parsed = JSON.parse(content);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}
