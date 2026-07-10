import fs from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "../src/config.mjs";
import { createTasklist } from "../src/lib/feishu-tasks.mjs";

const name = process.argv.slice(2).join(" ").trim() || "N哥时间管理大师";
const config = loadConfig();
const result = await createTasklist(config, name);
const tasklist = result?.data?.tasklist || result?.tasklist;
const guid = tasklist?.guid;
const url = tasklist?.url;

if (!guid) {
  console.log(JSON.stringify(result, null, 2));
  throw new Error("Tasklist created but no guid was returned.");
}

await upsertEnv("FEISHU_TASKLIST_GUID", guid);
console.log(`Tasklist created: ${name}`);
console.log(`GUID: ${guid}`);
if (url) console.log(`URL: ${url}`);

async function upsertEnv(key, value) {
  const envPath = path.resolve(".env");
  let content = "";
  try {
    content = await fs.readFile(envPath, "utf8");
  } catch {
    content = "";
  }
  const line = `${key}=${value}`;
  if (new RegExp(`^${key}=.*$`, "m").test(content)) {
    content = content.replace(new RegExp(`^${key}=.*$`, "m"), line);
  } else {
    content = `${content.trimEnd()}\n${line}\n`;
  }
  await fs.writeFile(envPath, content, "utf8");
}
