import test from "node:test";
import assert from "node:assert/strict";
import { addTasklistMember } from "../src/lib/feishu-tasks.mjs";

test("addTasklistMember is exported", () => {
  assert.equal(typeof addTasklistMember, "function");
});
