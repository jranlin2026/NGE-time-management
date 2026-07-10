import test from "node:test";
import assert from "node:assert/strict";
import { canCreateFeishuTasks, missingTaskConfig } from "../src/lib/feishu-tasks.mjs";

test("requires app credentials and tasklist guid to create tasks", () => {
  const config = { feishuAppId: "", feishuAppSecret: "", feishuTasklistGuid: "" };
  assert.equal(canCreateFeishuTasks(config), false);
  assert.deepEqual(missingTaskConfig(config), ["FEISHU_APP_ID", "FEISHU_APP_SECRET", "FEISHU_TASKLIST_GUID"]);
});
