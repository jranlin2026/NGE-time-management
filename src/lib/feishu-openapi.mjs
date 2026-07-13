const FEISHU_OPENAPI = "https://open.feishu.cn/open-apis";

export class FeishuOpenApiError extends Error {
  constructor(message, { status, code, method, path }) {
    super(message);
    this.name = "FeishuOpenApiError";
    this.status = status;
    this.code = code;
    this.method = method;
    this.path = path;
  }
}

export async function getTenantAccessToken(config) {
  if (!config.feishuAppId || !config.feishuAppSecret) {
    throw new Error("missing FEISHU_APP_ID or FEISHU_APP_SECRET");
  }

  const response = await fetch(`${FEISHU_OPENAPI}/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({
      app_id: config.feishuAppId,
      app_secret: config.feishuAppSecret,
    }),
  });
  const body = await response.json();
  if (!response.ok || body.code !== 0) {
    throw new Error(`failed to get tenant_access_token: ${JSON.stringify(body)}`);
  }
  return body.tenant_access_token;
}

export async function feishuRequest(config, path, { method = "GET", body } = {}) {
  const token = await getTenantAccessToken(config);
  const response = await fetch(`${FEISHU_OPENAPI}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json; charset=utf-8",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  const parsed = text ? JSON.parse(text) : {};
  if (!response.ok || parsed.code !== 0) {
    throw new FeishuOpenApiError(`Feishu OpenAPI failed ${method} ${path}: ${text}`, {
      status: response.status,
      code: parsed.code,
      method,
      path,
    });
  }
  return parsed;
}
