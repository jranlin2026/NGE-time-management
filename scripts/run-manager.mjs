import { loadConfig } from "../src/config.mjs";
import { createManagerApp } from "../src/manager-app.mjs";

const config = loadConfig();
for (const [name, value] of [
  ["FEISHU_APP_ID", config.feishuAppId],
  ["FEISHU_APP_SECRET", config.feishuAppSecret],
]) {
  if (!value) throw new Error(`Missing ${name}`);
}

const app = createManagerApp(config);
await app.start();
console.log(`Time manager started. Database: ${config.dbPath}`);

let stopping = false;
async function stop(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`Stopping time manager after ${signal}...`);
  await app.stop();
  process.exitCode = 0;
}

process.once("SIGINT", () => void stop("SIGINT"));
process.once("SIGTERM", () => void stop("SIGTERM"));
