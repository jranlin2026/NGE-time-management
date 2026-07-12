import assert from "node:assert/strict";
import test from "node:test";
import { deliverFeishuOutbound } from "../src/lib/feishu-delivery.mjs";
import { sendFeishuMessage } from "../src/lib/feishu-messages.mjs";

test("falls back to the group webhook before a personal receiver is bound", async () => {
  const calls = [];
  const result = await deliverFeishuOutbound(
    { feishuReceiveId: "", feishuWebhookUrl: "https://example.test/webhook" },
    { kind: "card", card: { header: { title: { content: "今日计划" } } }, text: "今日计划已生成" },
    {
      sendDirect: async () => { throw new Error("direct delivery should not run"); },
      sendWebhook: async (config, text) => {
        calls.push({ config, text });
        return { externalId: "webhook-message" };
      },
    },
  );

  assert.deepEqual(calls.map((call) => call.text), ["今日计划已生成"]);
  assert.deepEqual(result, { externalId: "webhook-message" });
});

test("sends a stable provider uuid no longer than 50 characters", async () => {
  const bodies = [];
  const payload = { kind: "text", text: "hello", idempotencyKey: "private-summary:very-long-key" };
  const request = async (_config, _path, options) => { bodies.push(options.body); return { data: { message_id: "om-1" } }; };
  await sendFeishuMessage({ feishuReceiveId: "ou-owner" }, payload, { request });
  await sendFeishuMessage({ feishuReceiveId: "ou-owner" }, payload, { request });
  assert.equal(bodies[0].uuid, bodies[1].uuid);
  assert.ok(bodies[0].uuid.length <= 50);
});

test("uses the personal receiver after it is bound", async () => {
  let directCalls = 0;
  const result = await deliverFeishuOutbound(
    { feishuReceiveId: "ou_bound" },
    { kind: "text", text: "已收到" },
    {
      sendDirect: async () => {
        directCalls += 1;
        return { externalId: "om_direct", chatId: "oc_direct" };
      },
      sendWebhook: async () => { throw new Error("webhook should not run"); },
    },
  );

  assert.equal(directCalls, 1);
  assert.deepEqual(result, { externalId: "om_direct", chatId: "oc_direct" });
});
