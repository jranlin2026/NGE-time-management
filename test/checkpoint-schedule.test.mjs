import assert from "node:assert/strict";
import test from "node:test";
import { CHECKPOINT_NODES, dueCheckpointNodes, resolveCheckpointContext } from "../src/lib/checkpoint-schedule.mjs";

test("exports the seven fixed checkpoint nodes", () => {
  assert.deepEqual(CHECKPOINT_NODES, ["08:00", "09:00", "12:00", "15:00", "18:00", "21:00", "24:00"]);
});

test("maps midnight to the previous work date review", () => {
  assert.deepEqual(resolveCheckpointContext({ now: "2026-07-14T00:00:00+08:00", timezone: "Asia/Shanghai" }), {
    workDate: "2026-07-13",
    currentNode: "24:00",
  });
});

test("keeps the overnight delay window on the previous day's review", () => {
  assert.deepEqual(resolveCheckpointContext({ now: "2026-07-14T00:03:00+08:00", timezone: "Asia/Shanghai" }), {
    workDate: "2026-07-13",
    currentNode: "24:00",
  });
  assert.deepEqual(dueCheckpointNodes({
    now: "2026-07-14T00:03:00+08:00", timezone: "Asia/Shanghai", completedNodes: [],
  }).nodes, ["24:00"]);
});

test("resolves the greatest node not after local time", () => {
  assert.deepEqual(resolveCheckpointContext({ now: "2026-07-13T16:59:00+08:00", timezone: "Asia/Shanghai" }), {
    workDate: "2026-07-13",
    currentNode: "15:00",
  });
});

test("runs missed 08:00 before 09:00", () => {
  assert.deepEqual(dueCheckpointNodes({ now: "2026-07-13T09:00:00+08:00", timezone: "Asia/Shanghai", completedNodes: [] }).nodes, ["24:00", "08:00", "09:00"]);
});

test("runs a missing previous review before a later recovery node", () => {
  assert.deepEqual(dueCheckpointNodes({ now: "2026-07-13T18:00:00+08:00", timezone: "Asia/Shanghai", completedNodes: ["08:00"] }).nodes, ["24:00", "18:00"]);
});

test("date-qualified completion removes both recovery prerequisites", () => {
  assert.deepEqual(dueCheckpointNodes({
    now: "2026-07-13T15:00:00+08:00", timezone: "Asia/Shanghai",
    completedNodes: ["2026-07-12:24:00", "2026-07-13:08:00"],
  }).nodes, ["15:00"]);
});

test("collapses expired progress checks at 18:00", () => {
  assert.deepEqual(dueCheckpointNodes({ now: "2026-07-13T18:00:00+08:00", timezone: "Asia/Shanghai", completedNodes: ["24:00", "08:00"] }).nodes, ["18:00"]);
});

test("runs an unfinished previous review before today's first dispatch", () => {
  assert.deepEqual(dueCheckpointNodes({ now: "2026-07-13T08:00:00+08:00", timezone: "Asia/Shanghai", completedNodes: [] }).nodes, ["24:00", "08:00"]);
});
