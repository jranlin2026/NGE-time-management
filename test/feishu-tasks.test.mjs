import test from "node:test";
import assert from "node:assert/strict";
import { buildTaskUpdateBody, canCreateFeishuTasks, missingTaskConfig } from "../src/lib/feishu-tasks.mjs";

test("requires app credentials and tasklist guid to create tasks", () => {
  const config = { feishuAppId: "", feishuAppSecret: "", feishuTasklistGuid: "" };
  assert.equal(canCreateFeishuTasks(config), false);
  assert.deepEqual(missingTaskConfig(config), ["FEISHU_APP_ID", "FEISHU_APP_SECRET", "FEISHU_TASKLIST_GUID"]);
});

test("builds explicit Feishu task update fields", () => {
  assert.deepEqual(buildTaskUpdateBody({ summary: "拍视频", completedAt: "2026-07-10T04:00:00.000Z" }), {
    task: { summary: "拍视频", completed_at: "1783656000000" },
    update_fields: ["summary", "completed_at"],
  });
});
