import assert from "node:assert/strict";
import test from "node:test";
import { openDatabase } from "../src/db/database.mjs";
import { createOperationsRepository } from "../src/db/operations-repository.mjs";
import { createOutboxWorker } from "../src/lib/outbox-worker.mjs";
import { sendFeishuMessage } from "../src/lib/feishu-messages.mjs";

test("sends private checkpoint summaries as owner open_id plain text", async () => {
  let request;
  await sendFeishuMessage({ feishuReceiveId: "fallback", feishuReceiveIdType: "chat_id" }, {
    kind: "private_checkpoint_summary", text: "合并总结", receiveId: "ou-owner", receiveIdType: "open_id",
  }, { request: async (_config, path, options) => { request = { path, options }; return { data: { message_id: "om-1" } }; } });
  assert.match(request.path, /receive_id_type=open_id/);
  assert.deepEqual(request.options.body, { receive_id: "ou-owner", msg_type: "text", content: JSON.stringify({ text: "合并总结" }) });
});

test("retries twice with backoff and records external id on third success", async () => {
  let now = new Date("2026-07-10T00:00:00.000Z");
  let calls = 0;
  let sequence = 0;
  const db = openDatabase(":memory:");
  const ops = createOperationsRepository(db, {
    now: () => now.toISOString(),
    id: () => `id-${++sequence}`,
  });
  ops.enqueueOutbox({ kind: "text", payload: { text: "test" }, idempotencyKey: "one" });
  const worker = createOutboxWorker({
    ops,
    clock: { now: () => now },
    send: async () => {
      calls += 1;
      if (calls < 3) throw new Error(`failure-${calls}`);
      return { externalId: "om-success" };
    },
  });

  assert.equal(await worker.flush(), 1);
  assert.equal(ops.listOutbox()[0].nextAttemptAt, "2026-07-10T00:00:30.000Z");
  now = new Date("2026-07-10T00:00:30.000Z");
  assert.equal(await worker.flush(), 1);
  assert.equal(ops.listOutbox()[0].nextAttemptAt, "2026-07-10T00:02:30.000Z");
  now = new Date("2026-07-10T00:02:30.000Z");
  assert.equal(await worker.flush(), 1);
  assert.equal(ops.listOutbox()[0].status, "sent");
  assert.equal(ops.listOutbox()[0].externalId, "om-success");
  db.close();
});

test("marks the eighth failed delivery as failed", async () => {
  let now = new Date("2026-07-10T00:00:00.000Z");
  let sequence = 0;
  const db = openDatabase(":memory:");
  const ops = createOperationsRepository(db, { now: () => now.toISOString(), id: () => `id-${++sequence}` });
  ops.enqueueOutbox({ kind: "text", payload: { text: "test" }, idempotencyKey: "dead" });
  const worker = createOutboxWorker({ ops, clock: { now: () => now }, send: async () => { throw new Error("offline"); } });

  for (let attempt = 0; attempt < 8; attempt += 1) {
    await worker.flush();
    const row = ops.listOutbox()[0];
    now = new Date(row.nextAttemptAt);
  }
  assert.equal(ops.listOutbox()[0].status, "failed");
  assert.equal(ops.listOutbox()[0].attempts, 8);
  db.close();
});

test("redacts credentials from retry errors", async () => {
  const db = openDatabase(":memory:");
  const ops = createOperationsRepository(db, { now: () => "2026-07-10T00:00:00.000Z", id: () => "id-secret" });
  ops.enqueueOutbox({ kind: "text", payload: { text: "test" }, idempotencyKey: "secret" });
  const worker = createOutboxWorker({
    ops, clock: { now: () => new Date("2026-07-10T00:00:00.000Z") },
    send: async () => { throw new Error("authorization: Bearer very-secret app_secret=also-secret"); },
  });
  await worker.flush();
  assert.doesNotMatch(ops.listOutbox()[0].lastError, /very-secret|also-secret/);
  db.close();
});
