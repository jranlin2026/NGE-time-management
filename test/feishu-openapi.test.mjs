import assert from "node:assert/strict";
import test from "node:test";
import { FeishuOpenApiError, feishuRequest } from "../src/lib/feishu-openapi.mjs";

test("preserves the HTTP status on Feishu API failures for manifest-scoped 404 handling", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const responses = [
    response(200, { code: 0, tenant_access_token: "token" }),
    response(404, { code: 125404, msg: "not found" }),
  ];
  globalThis.fetch = async () => responses.shift();

  await assert.rejects(
    () => feishuRequest({ feishuAppId: "app", feishuAppSecret: "secret" }, "/task/v2/tasks/missing", { method: "DELETE" }),
    (error) => error instanceof FeishuOpenApiError && error.status === 404 && error.code === 125404,
  );
});

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return body; },
    async text() { return JSON.stringify(body); },
  };
}
