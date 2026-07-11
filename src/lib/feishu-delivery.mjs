import { sendFeishuText } from "./feishu.mjs";
import { sendFeishuMessage } from "./feishu-messages.mjs";

export async function deliverFeishuOutbound(config, payload, dependencies = {}) {
  const sendDirect = dependencies.sendDirect || sendFeishuMessage;
  const sendWebhook = dependencies.sendWebhook || ((webhookConfig, text) => sendFeishuText(webhookConfig, text));

  if (config.feishuReceiveId) return sendDirect(config, payload);
  if (config.feishuWebhookUrl) return sendWebhook(config, payload.text || "时间管理计划已更新。");
  throw new Error("missing FEISHU_RECEIVE_ID and FEISHU_WEBHOOK_URL");
}
