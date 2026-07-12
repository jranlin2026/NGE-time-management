import test from "node:test";
import assert from "node:assert/strict";
import {
  buildTaskBody,
  buildTaskUpdateBody,
  canCreateFeishuTasks,
  listSubtasks,
  listTasklistTasks,
  missingTaskConfig,
} from "../src/lib/feishu-tasks.mjs";

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

test("creates timed parents in the tasklist and children outside it", () => {
  const config = { feishuTasklistGuid: "list-1", feishuTaskAssigneeId: "ou-owner" };
  const parent = buildTaskBody(config, {
    summary: "拍摄视频",
    startAt: "2026-07-13T02:00:00.000Z",
    dueAt: "2026-07-13T04:00:00.000Z",
  });
  const child = buildTaskBody(config, {
    summary: "写脚本",
    dueAt: "2026-07-13T02:30:00.000Z",
  }, { includeTasklist: false });

  assert.equal(parent.start.is_all_day, false);
  assert.equal(parent.start.timestamp, "1783908000000");
  assert.equal(parent.due.timestamp, "1783915200000");
  assert.deepEqual(parent.tasklists, [{ tasklist_guid: "list-1" }]);
  assert.equal("tasklists" in child, false);
});

test("paginates tasklist tasks and subtasks by has_more", async () => {
  const paths = [];
  const request = async (_config, path) => {
    paths.push(path);
    if (!path.includes("page_token=")) return { data: { items: [{ guid: "one" }], has_more: true, page_token: "next token" } };
    return { data: { items: [{ guid: "two" }], has_more: false } };
  };

  assert.deepEqual((await listTasklistTasks({ feishuTasklistGuid: "list/1" }, {}, { request })).map((item) => item.guid), ["one", "two"]);
  assert.deepEqual((await listSubtasks({}, "parent/1", { request })).map((item) => item.guid), ["one", "two"]);
  assert.equal(paths.some((path) => path.includes("tasklists/list%2F1/tasks?page_size=100&user_id_type=open_id")), true);
  assert.equal(paths.some((path) => path.includes("tasks/parent%2F1/subtasks?page_size=100&user_id_type=open_id")), true);
  assert.equal(paths.filter((path) => path.includes("page_token=next+token")).length, 2);
});
