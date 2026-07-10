import assert from "node:assert/strict";
import test from "node:test";
import {
  renderCurrentTaskCard,
  renderDailyPlanCard,
  renderInterventionCard,
  renderReviewCard,
} from "../src/lib/feishu-cards.mjs";
import { extractCardAction, normalizeManagerAction } from "../src/lib/feishu-messages.mjs";

const task = {
  id: "task-1",
  title: "拍摄 3 条 Codex 口播",
  nextAction: "打开第一条提纲开始录制",
  doneDefinition: "3 条可剪辑素材交给剪辑",
  project: "个人IP",
};

test("current task card exposes four actions with task id", () => {
  const card = renderCurrentTaskCard({ task, startsAt: "10:00", endsAt: "12:00" });
  const buttons = card.body.elements.find((element) => element.tag === "action").actions;
  assert.deepEqual(
    buttons.map((button) => button.behaviors[0].value.action),
    ["start", "complete", "block", "defer_30"],
  );
  assert.ok(buttons.every((button) => button.behaviors[0].value.taskId === "task-1"));
});

test("renders plan, intervention, and review cards with factual content", () => {
  const plan = renderDailyPlanCard({ date: "2026-07-10", blocks: [{ ...task, startsAt: "10:00", endsAt: "12:00", reason: "个人IP阶段优先" }] });
  const intervention = renderInterventionCard({ task, minimumAction: "打开相机说完第一遍", minutes: 15 });
  const review = renderReviewCard({ date: "2026-07-10", criticalCompleted: 2, criticalPlanned: 3, completionRate: 67, procrastinationCount: 1, tomorrowCandidates: ["极享 OS 测试"] });
  assert.match(JSON.stringify(plan), /个人IP阶段优先/);
  assert.match(JSON.stringify(intervention), /打开相机说完第一遍/);
  assert.match(JSON.stringify(review), /67%/);
});

test("normalizes card buttons and text commands into the same actions", () => {
  assert.deepEqual(
    normalizeManagerAction({ value: { action: "start", taskId: "task-1" }, eventId: "evt-1" }),
    { action: "start", taskId: "task-1", query: "", detail: "", idempotencyKey: "card:evt-1" },
  );
  assert.deepEqual(normalizeManagerAction("开始：拍视频"), {
    action: "start", taskId: "", query: "拍视频", detail: "", idempotencyKey: "",
  });
  assert.equal(normalizeManagerAction("完成：拍视频").action, "complete");
  assert.equal(normalizeManagerAction("卡住：拍视频 不知道怎么开头").action, "block");
  assert.equal(normalizeManagerAction("推迟30分钟：拍视频").action, "defer_30");
  assert.equal(normalizeManagerAction("恢复：拍视频").action, "restore");
});

test("extracts a Feishu card event id and value", () => {
  assert.deepEqual(extractCardAction({
    header: { event_id: "evt-2" },
    event: { action: { value: { action: "complete", taskId: "task-1" } } },
  }), {
    value: { action: "complete", taskId: "task-1" },
    eventId: "evt-2",
  });
});
