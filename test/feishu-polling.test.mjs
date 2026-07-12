import assert from "node:assert/strict";
import test from "node:test";
import {
  listConversationMessages,
  normalizePolledMessage,
  resolveDirectChatId,
} from "../src/lib/feishu-polling.mjs";

function rawMessage(messageId, senderId, senderType, text, createTime) {
  return {
    message_id: messageId,
    sender: { id: senderId, sender_type: senderType },
    msg_type: "text",
    body: { content: JSON.stringify({ text }) },
    create_time: createTime,
  };
}

test("reads every history page and keeps only owner messages", async () => {
  const paths = [];
  const request = async (_config, path) => {
    paths.push(path);
    if (!path.includes("page_token=")) {
      return { data: { has_more: true, page_token: "next", items: [rawMessage("om-1", "ou-owner", "user", "第一条", "1000")] } };
    }
    return { data: { has_more: false, items: [
      rawMessage("om-2", "cli-bot", "app", "机器人回复", "2000"),
      rawMessage("om-other", "ou-other", "user", "其他人", "2500"),
      rawMessage("om-3", "ou-owner", "user", "第二条", "3000"),
    ] } };
  };

  const messages = await listConversationMessages(
    { managerUserId: "ou-owner" },
    { chatId: "oc-p2p", startTime: "1", endTime: "4" },
    { request },
  );

  assert.deepEqual(messages.map((item) => item.messageId), ["om-1", "om-3"]);
  assert.equal(paths.length, 2);
  assert.match(paths[0], /container_id=oc-p2p/);
  assert.match(paths[0], /start_time=1/);
  assert.match(paths[0], /end_time=4/);
  assert.match(paths[1], /page_token=next/);
});

test("continues pagination when an intermediate page has no items", async () => {
  let calls = 0;
  const messages = await listConversationMessages(
    { managerUserId: "ou-owner" },
    { chatId: "oc-p2p" },
    { request: async () => {
      calls += 1;
      if (calls === 1) return { data: { has_more: true, page_token: "next", items: [] } };
      return { data: { has_more: false, items: [rawMessage("om-1", "ou-owner", "user", "有内容", "1000")] } };
    } },
  );

  assert.equal(calls, 2);
  assert.deepEqual(messages.map((item) => item.messageId), ["om-1"]);
});

test("normalizes text without guessing image contents", () => {
  const text = normalizePolledMessage(rawMessage("om-1", "ou-owner", "user", "你好", "1000"));
  assert.deepEqual(text.content, { text: "你好" });

  const image = normalizePolledMessage({
    ...rawMessage("om-2", "ou-owner", "user", "{}", "2000"),
    msg_type: "image",
    body: { content: "{\"image_key\":\"img-1\"}" },
  });
  assert.deepEqual(image.content, { imageKey: "img-1", unavailableForTextAnalysis: true });
});

test("captures the p2p chat id returned by a bootstrap DM", async () => {
  const values = new Map();
  const chatId = await resolveDirectChatId(
    { feishuReceiveId: "ou-owner", feishuReceiveIdType: "open_id" },
    { getSetting: (key) => values.get(key), setSetting: (key, value) => values.set(key, value) },
    { send: async () => ({ externalId: "om-bootstrap", chatId: "oc-p2p" }) },
  );
  assert.equal(chatId, "oc-p2p");
  assert.equal(values.get("feishu_p2p_chat_id"), "oc-p2p");
});

test("resolves direct chat id from config before persisted settings", async () => {
  let sends = 0;
  const chatId = await resolveDirectChatId(
    { feishuP2pChatId: "oc-config" },
    { getSetting: () => "oc-setting", setSetting() {} },
    { send: async () => { sends += 1; return { chatId: "oc-bootstrap" }; } },
  );
  assert.equal(chatId, "oc-config");
  assert.equal(sends, 0);
});

test("throws when the bootstrap DM does not return a chat id", async () => {
  await assert.rejects(
    resolveDirectChatId(
      { feishuReceiveId: "ou-owner" },
      { getSetting: () => "", setSetting() {} },
      { send: async () => ({ externalId: "om-bootstrap", chatId: "" }) },
    ),
    /chat_id/i,
  );
});
