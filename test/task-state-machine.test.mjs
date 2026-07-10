import assert from "node:assert/strict";
import test from "node:test";
import { transitionTask } from "../src/lib/task-state-machine.mjs";

const NOW = "2026-07-10T02:00:00.000Z";
const ready = { id: "t1", status: "ready", procrastinationCount: 0 };
const doing = { ...ready, status: "doing" };
const done = { ...ready, status: "done" };

test("applies legal task transitions", () => {
  assert.equal(transitionTask({ task: ready, action: "start", at: NOW }).patch.status, "doing");
  assert.equal(transitionTask({ task: doing, action: "complete", at: NOW }).patch.status, "done");
  assert.equal(
    transitionTask({ task: doing, action: "block", detail: "不知道怎么开头", at: NOW }).patch.status,
    "blocked",
  );
  assert.equal(transitionTask({ task: ready, action: "defer", at: NOW }).patch.status, "deferred");
  assert.equal(transitionTask({ task: done, action: "restore", at: NOW }).patch.status, "ready");
});

test("rejects illegal transitions and only explicit restore reopens done", () => {
  assert.throws(() => transitionTask({ task: done, action: "start", at: NOW }), /illegal transition/);
  assert.throws(() => transitionTask({ task: done, action: "complete", at: NOW }), /illegal transition/);
});

test("records block detail without counting proactive feedback as procrastination", () => {
  const result = transitionTask({ task: doing, action: "block", detail: "AI 文案不自然", at: NOW });
  assert.deepEqual(result.patch, {
    status: "blocked",
    blocker: "AI 文案不自然",
    procrastinationCount: 0,
  });
  assert.equal(result.event.kind, "task_blocked");
});

test("second no-response increments procrastination exactly once", () => {
  const result = transitionTask({ task: ready, action: "no_response_2", at: NOW });
  assert.equal(result.patch.status, "ready");
  assert.equal(result.patch.procrastinationCount, 1);
  assert.equal(result.event.kind, "procrastination_recorded");
});
