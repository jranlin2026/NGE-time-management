import { loadConfig } from "../src/config.mjs";
import { ingestNaturalTask } from "../src/lib/ingest.mjs";

const text = process.argv.slice(2).join(" ").trim();
if (!text) {
  console.error('Usage: npm run ingest -- "新增任务：7月8日前完成直播邀约名单确认"');
  process.exit(1);
}

const config = loadConfig();
const task = await ingestNaturalTask(config.kbDir, text);
console.log(`Task added: ${task.title}`);
console.log(`Project: ${task.project}`);
console.log(`Quadrant: ${task.quadrant}`);
