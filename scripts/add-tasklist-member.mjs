import { loadConfig } from "../src/config.mjs";
import { addTasklistMember } from "../src/lib/feishu-tasks.mjs";

const config = loadConfig();
const memberId = process.argv[2] || config.feishuTasklistMemberId;
const idType = process.argv[3] || config.feishuTasklistMemberIdType || "open_id";
const memberType = process.argv[4] || "user";
const role = process.argv[5] || "editor";

if (!memberId) {
  console.error("Usage: npm.cmd run tasklist:add-member -- <open_id_or_user_id> [open_id|user_id] [user|chat|app] [editor|viewer]");
  process.exit(1);
}

const result = await addTasklistMember(config, config.feishuTasklistGuid, memberId, {
  idType,
  memberType,
  role,
});

console.log("Tasklist member added.");
console.log(JSON.stringify({
  tasklistGuid: config.feishuTasklistGuid,
  memberId,
  idType,
  memberType,
  role,
  url: result?.data?.tasklist?.url,
}, null, 2));
