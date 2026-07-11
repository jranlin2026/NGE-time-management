import path from "node:path";
import fs from "node:fs";

const defaultKbDir = process.platform === "darwin"
  ? "/Users/nge/MAC BOOK的WPS云盘/林恩光的知识库/01_FounderOS_林总个人OS/08_时间管理大师"
  : "C:\\Users\\jranl\\WPSDrive\\196914891\\WPS云盘\\林恩光的知识库\\01_FounderOS_林总个人OS\\08_时间管理大师";

export function loadConfig(env = process.env) {
  const dotEnv = env === process.env ? readDotEnv(path.resolve(".env")) : {};
  const merged = mergeEnv(dotEnv, env);
  const dataDir = path.resolve(merged.TIME_MASTER_DATA_DIR || path.join(process.cwd(), "data"));
  const schedule = {
    plan: merged.TIME_MASTER_PLAN_TIME || "08:00",
    firstTask: merged.TIME_MASTER_FIRST_TASK_TIME || "10:00",
    midday: merged.TIME_MASTER_MIDDAY_TIME || "12:00",
    afternoon: merged.TIME_MASTER_AFTERNOON_TIME || "14:00",
    dayClose: merged.TIME_MASTER_DAY_CLOSE_TIME || "18:00",
    eveningStart: merged.TIME_MASTER_EVENING_START || "20:00",
    eveningEnd: merged.TIME_MASTER_EVENING_END || "24:00",
    noResponseMinutes: Number(merged.TIME_MASTER_NO_RESPONSE_MINUTES || 10),
  };
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
    feishuReceiveId: merged.FEISHU_RECEIVE_ID || "",
    feishuReceiveIdType: merged.FEISHU_RECEIVE_ID_TYPE || "open_id",
    dataDir,
    dbPath: path.resolve(merged.TIME_MASTER_DB_PATH || path.join(dataDir, "time-manager.sqlite")),
    backupDir: path.resolve(merged.TIME_MASTER_BACKUP_DIR || path.join(dataDir, "backups")),
    markdownExportDir: path.resolve(merged.TIME_MASTER_MARKDOWN_DIR || path.join(dataDir, "exports")),
    codexBin: merged.CODEX_BIN || "/Applications/ChatGPT.app/Contents/Resources/codex",
    codexModel: merged.CODEX_MODEL || "gpt-5.3-codex-spark",
    codexReasoningEffort: merged.CODEX_REASONING_EFFORT || "low",
    codexTimeoutMs: Number(merged.CODEX_TIMEOUT_MS || 45_000),
    timezone: merged.TIME_MASTER_TIMEZONE || "Asia/Shanghai",
    managerUserId: merged.TIME_MASTER_USER_ID || "",
    schedule,
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
