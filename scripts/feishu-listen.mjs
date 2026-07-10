import { loadConfig } from "../src/config.mjs";
import { extractMessageText, handleFeishuInbound } from "../src/lib/feishu-events.mjs";

const config = loadConfig();

if (!config.feishuAppId || !config.feishuAppSecret) {
  console.error("Missing FEISHU_APP_ID or FEISHU_APP_SECRET.");
  process.exit(1);
}

console.log("Starting Feishu WebSocket listener...");
console.log("If this does not connect, check Feishu Open Platform event subscription and app release status.");

const lark = await import("@larksuiteoapi/node-sdk");
const seenMessageIds = new Set();

const dispatcher = new lark.EventDispatcher({
  verificationToken: config.feishuVerificationToken || undefined,
  encryptKey: config.feishuEncryptKey || undefined,
});

dispatcher.register({
  "im.message.receive_v1": async (data) => {
    const extracted = extractMessageText(data);
    if (extracted.messageId && seenMessageIds.has(extracted.messageId)) {
      console.log(`Skip duplicate Feishu message: ${extracted.messageId}`);
      return;
    }
    if (extracted.messageId) seenMessageIds.add(extracted.messageId);

    console.log(
      JSON.stringify({
        received: true,
        messageId: extracted.messageId,
        chatId: extracted.chatId,
        text: extracted.text,
      }),
    );

    const result = await handleFeishuInbound(config, data);
    console.log(
      JSON.stringify({
        handled: true,
        action: result.action,
        messageId: extracted.messageId,
      }),
    );
  },
});

const wsClient = new lark.WSClient({
  appId: config.feishuAppId,
  appSecret: config.feishuAppSecret,
  autoReconnect: true,
  loggerLevel: lark.LoggerLevel.info,
  onReady: () => console.log("Feishu WebSocket connected. Waiting for group messages..."),
  onReconnecting: () => console.log("Feishu WebSocket reconnecting..."),
  onReconnected: () => console.log("Feishu WebSocket reconnected."),
  onError: (error) => {
    console.error("Feishu WebSocket error:", error.message);
  },
});

await wsClient.start({ eventDispatcher: dispatcher });
