import { loadConfig } from "../src/config.mjs";
import { dispatchToday } from "../src/lib/dispatch.mjs";

const config = loadConfig();
const result = await dispatchToday(config);

console.log(`Daily plan written: ${result.file}`);
if (result.feishuTasks.skipped) console.log(`Feishu task creation skipped: ${result.feishuTasks.reason}`);
else console.log(`Feishu task created: ${result.feishuTasks.parentUrl || "(no link returned)"}`);
if (result.feishu.skipped) console.log(`Feishu skipped: ${result.feishu.reason}`);
else console.log(`Feishu response: ${result.feishu.status}`);
