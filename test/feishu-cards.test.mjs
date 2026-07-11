import assert from "node:assert/strict";
import test from "node:test";
import {
  renderCurrentTaskCard,
  renderDailyPlanCard,
  renderInterventionCard,
  renderProjectSetupCard,
  renderReviewCard,
  renderWeeklyPlanCard,
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
  const row = card.body.elements.find((element) => element.tag === "column_set");
  const buttons = row.columns.flatMap((column) => column.elements);
  assert.equal(row.flex_mode, "flow");
  assert.equal(row.columns.length, 4);
  assert.deepEqual(
    buttons.map((button) => button.behaviors[0].value.action),
    ["start", "complete", "block", "defer_30"],
  );
  assert.ok(buttons.every((button) => button.behaviors[0].value.taskId === "task-1"));
});

test("doing task card shows its status and removes the start action", () => {
  const card = renderCurrentTaskCard({
    task: { ...task, status: "doing" },
    startsAt: "已开始",
    endsAt: "完成为止",
  });
  const row = card.body.elements.find((element) => element.tag === "column_set");
  const buttons = row.columns.flatMap((column) => column.elements);

  assert.match(JSON.stringify(card), /进行中/);
  assert.deepEqual(
    buttons.map((button) => button.behaviors[0].value.action),
    ["complete", "block", "defer_30"],
  );
});

test("current task card exposes incomplete checkpoints as individual actions", () => {
  const card = renderCurrentTaskCard({
    task: { ...task, checkpoints: [{ title: "写脚本", completed: true }, { title: "录制素材", completed: false }] },
    startsAt: "10:00",
    endsAt: "12:00",
  });
  const buttons = card.body.elements.filter((element) => element.tag === "button");
  const checkpoint = buttons.find((button) => button.behaviors[0].value.action === "complete_checkpoint");
  assert.equal(checkpoint.text.content, "○ 录制素材");
  assert.deepEqual(checkpoint.behaviors[0].value, { action: "complete_checkpoint", taskId: "task-1", checkpointIndex: 1 });
  assert.match(JSON.stringify(card), /✓ 写脚本/);
});

test("renders plan, intervention, and review cards with factual content", () => {
  const plan = renderDailyPlanCard({
    date: "2026-07-10",
    blocks: [{ ...task, startsAt: "10:00", endsAt: "12:00", reason: "个人IP阶段优先" }],
    capacityWarnings: ["个人IP 最低容量无法在容量上限内排入"],
  });
  const intervention = renderInterventionCard({ task, minimumAction: "打开相机说完第一遍", minutes: 15 });
  const review = renderReviewCard({ date: "2026-07-10", criticalCompleted: 2, criticalPlanned: 3, completionRate: 67, procrastinationCount: 1, tomorrowCandidates: ["极享 OS 测试"] });
  assert.match(JSON.stringify(plan), /个人IP阶段优先/);
  assert.match(JSON.stringify(plan), /最低容量无法在容量上限内排入/);
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
  assert.deepEqual(normalizeManagerAction("推迟30分钟：拍视频｜客户临时电话"), {
    action: "defer_30", taskId: "", query: "拍视频", detail: "客户临时电话", idempotencyKey: "",
  });
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

test("retains realistic Feishu card operator identities", () => {
  const direct = extractCardAction({
    header: { event_id: "evt-direct" },
    event: { operator: { open_id: "ou_owner" }, action: { value: { action: "accept_evidence", taskId: "task-1" } } },
  });
  assert.equal(normalizeManagerAction(direct).actorId, "ou_owner");
  const nested = extractCardAction({
    event: { event_id: "evt-nested", operator: { operator_id: { open_id: "ou_nested" } }, action: { value: { action: "reject_evidence", taskId: "task-1" } } },
  });
  assert.equal(normalizeManagerAction(nested).actorId, "ou_nested");
});

function allActions(card) {
  const actions = [];
  const visit = (value) => {
    if (Array.isArray(value)) return value.forEach(visit);
    if (!value || typeof value !== "object") return;
    if (value.tag === "button") actions.push(value.behaviors[0].value.action);
    Object.values(value).forEach(visit);
  };
  visit(card);
  return actions;
}

test("weekly plan card exposes confirm and adjustment actions with normalized identity", () => {
  const card = renderWeeklyPlanCard({
    weekId: "2026-W29",
    version: 1,
    plan: { outcomes: ["发布首条视频"], tasks: [{ projectName: "个人IP", title: "发布视频", completionStandard: "链接可访问" }] },
  });
  assert.deepEqual(allActions(card), ["confirm_weekly_plan", "adjust_weekly_plan"]);
  assert.deepEqual(card.body.elements.at(-2).behaviors[0].value, { action: "confirm_weekly_plan", taskId: "", weekId: "2026-W29", version: 1 });
});

test("project setup card exposes one confirmation action", () => {
  const card = renderProjectSetupCard({ projects: [{ id: "personal-ip", name: "个人IP", status: "draft", contentHash: "hash-1" }] });
  assert.deepEqual(allActions(card), ["confirm_project_setup"]);
  assert.deepEqual(card.body.elements.at(-1).behaviors[0].value.projects, [{ projectId: "personal-ip", contentHash: "hash-1" }]);
});

test("normalizes weekly card identity and adjustment text", () => {
  assert.deepEqual(normalizeManagerAction({
    value: { action: "confirm_weekly_plan", weekId: " 2026-W29 ", version: "2" }, eventId: "evt-weekly",
  }), {
    action: "confirm_weekly_plan", taskId: "", weekId: "2026-W29", version: 2,
    query: "", detail: "", idempotencyKey: "card:evt-weekly",
  });
  assert.deepEqual(normalizeManagerAction("调整周计划｜任务太多"), {
    action: "adjust_weekly_plan", taskId: "", query: "", detail: "任务太多", idempotencyKey: "",
  });
});
