import test from "node:test";
import assert from "node:assert/strict";
import { parseNaturalTask } from "../src/lib/ingest.mjs";

test("parses live stream tasks into the live project", () => {
  const task = parseNaturalTask("新增任务：2026-07-08 前完成直播助教分工确认");
  assert.equal(task.project, "7月8日AI获客变现实战课");
  assert.equal(task.due, "2026-07-08");
  assert.equal(task.importance, "A");
});
