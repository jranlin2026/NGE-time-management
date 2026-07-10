import crypto from "node:crypto";

export async function sendFeishuText({ webhookUrl, secret }, text) {
  webhookUrl ||= arguments[0]?.feishuWebhookUrl;
  secret ||= arguments[0]?.feishuWebhookSecret;
  if (!webhookUrl) return { skipped: true, reason: "missing FEISHU_WEBHOOK_URL" };
  const payload = {
    msg_type: "text",
    content: { text },
  };
  if (secret) {
    const timestamp = Math.floor(Date.now() / 1000);
    payload.timestamp = String(timestamp);
    payload.sign = signFeishu(timestamp, secret);
  }
  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await response.text();
  return { ok: response.ok, status: response.status, body };
}

export function signFeishu(timestamp, secret) {
  const stringToSign = `${timestamp}\n${secret}`;
  return crypto.createHmac("sha256", stringToSign).update("").digest("base64");
}

export function extractFeishuText(eventBody) {
  if (eventBody.challenge) return { kind: "challenge", challenge: eventBody.challenge };
  const event = eventBody.event || eventBody;
  const message = event.message || event;
  const raw = message.content || event.content || "";
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return { kind: "message", text: parsed.text || raw };
    } catch {
      return { kind: "message", text: raw };
    }
  }
  return { kind: "message", text: raw.text || "" };
}
