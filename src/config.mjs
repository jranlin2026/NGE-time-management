import path from "node:path";
import fs from "node:fs";

const defaultKbDir =
  "C:\\Users\\jranl\\WPSDrive\\196914891\\WPS云盘\\林恩光的知识库\\01_FounderOS_林总个人OS\\08_时间管理大师";

export function loadConfig(env = process.env) {
  const dotEnv = env === process.env ? readDotEnv(path.resolve(".env")) : {};
  const merged = mergeEnv(dotEnv, env);
  return {
    port: Number(merged.PORT || 8787),
    kbDir: path.resolve(merged.TIME_MASTER_KB_DIR || defaultKbDir),
    feishuWebhookUrl: merged.FEISHU_WEBHOOK_URL || "",
    feishuWebhookSecret: merged.FEISHU_WEBHOOK_SECRET || "",
    feishuAppId: merged.FEISHU_APP_ID || "",
    feishuAppSecret: merged.FEISHU_APP_SECRET || "",
    feishuTasklistGuid: merged.FEISHU_TASKLIST_GUID || "",
    feishuTaskAssigneeId: merged.FEISHU_TASK_ASSIGNEE_ID || "",
    feishuTasklistMemberId: merged.FEISHU_TASKLIST_MEMBER_ID || "",
    feishuTasklistMemberIdType: merged.FEISHU_TASKLIST_MEMBER_ID_TYPE || "open_id",
    feishuVerificationToken: merged.FEISHU_VERIFICATION_TOKEN || "",
    feishuEncryptKey: merged.FEISHU_ENCRYPT_KEY || "",
  };
}

function mergeEnv(base, override) {
  const result = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value !== undefined && value !== "") result[key] = value;
  }
  return result;
}

function readDotEnv(file) {
  if (!fs.existsSync(file)) return {};
  const result = {};
  const content = fs.readFileSync(file, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const index = line.indexOf("=");
    if (index === -1) continue;
    const key = line.slice(0, index).trim();
    const value = line.slice(index + 1).trim().replace(/^["']|["']$/g, "");
    result[key] = value;
  }
  return result;
}
