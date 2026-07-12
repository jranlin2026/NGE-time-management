import assert from "node:assert/strict";
import test from "node:test";
import { createCodexAnalyzer, fallbackTaskAnalysis, validateWeeklyPlan } from "../src/lib/codex-analyzer.mjs";

test("returns validated Codex task analysis", async () => {
  const analyzer = createCodexAnalyzer(
    { timezone: "Asia/Shanghai" },
    {
      run: async () =>
        JSON.stringify({
          intent: "create_task",
          title: "拍摄 3 条口播",
          project: "个人IP",
          quadrant: "重要且紧急",
          importance: "A",
          urgency: "high",
          dueAt: "2026-07-10T10:00:00.000Z",
          estimateMinutes: 120,
          nextAction: "打开第一条提纲开始录制",
          doneDefinition: "3 条可剪辑素材交给剪辑",
          confidence: 0.93,
        }),
    },
  );

  const result = await analyzer.analyzeTask({
    rawInput: "今天拍 3 条口播",
    now: "2026-07-10T00:30:00.000Z",
  });

  assert.equal(result.analysisStatus, "complete");
  assert.equal(result.project, "个人IP");
  assert.equal(result.estimateMinutes, 120);
});

test("falls back without losing original task when Codex fails", async () => {
  const analyzer = createCodexAnalyzer({}, { run: async () => { throw new Error("timeout"); } });
  const result = await analyzer.analyzeTask({ rawInput: "优化极享 OS" });

  assert.equal(result.analysisStatus, "failed");
  assert.equal(result.title, "优化极享 OS");
  assert.equal(result.estimateMinutes, 30);
  assert.match(result.analysisError, /timeout/);
});

test("rejects invalid analyzer values and uses fallback", async () => {
  const analyzer = createCodexAnalyzer({}, {
    run: async () => JSON.stringify({ intent: "create_task", estimateMinutes: 9999 }),
  });
  const result = await analyzer.analyzeTask({ rawInput: "确认合同" });

  assert.equal(result.analysisStatus, "failed");
  assert.match(result.analysisError, /missing field|estimateMinutes/);
});

test("returns a fixed 15-minute minimum action", async () => {
  const analyzer = createCodexAnalyzer({}, {
    run: async ({ mode }) => mode === "minimum_action"
      ? JSON.stringify({ action: "打开相机，把第一条完整说一遍", minutes: 15 })
      : "{}",
  });
  const result = await analyzer.minimumAction({
    task: { nextAction: "开始拍摄" },
    blocker: "一直改稿",
  });

  assert.deepEqual(result, { action: "打开相机，把第一条完整说一遍", minutes: 15 });
});

test("analyzes acceptance with the restricted decision schema", async () => {
  let invocation;
  const analyzer = createCodexAnalyzer({}, {
    run: async (input) => {
      invocation = input;
      return JSON.stringify({ status: "needs_user_confirmation", explanation: "链接无法访问" });
    },
  });
  const result = await analyzer.analyzeAcceptance({ task: { title: "发布视频" }, evidence: [{ type: "url", value: "https://example.com" }] });
  assert.equal(result.status, "needs_user_confirmation");
  assert.equal(invocation.mode, "acceptance");
  assert.match(invocation.schemaPath, /codex-acceptance-schema\.json$/);
});

test("fallback is deterministic", () => {
  assert.deepEqual(fallbackTaskAnalysis(" 写完方案 "), {
    intent: "create_task",
    title: "写完方案",
    project: "未归类",
    quadrant: "重要不紧急",
    importance: "B",
    urgency: "medium",
    dueAt: null,
    estimateMinutes: 30,
    nextAction: "先做 15 分钟，明确第一个可交付动作",
    doneDefinition: "提交明确产出并反馈完成",
    confidence: 0,
    analysisStatus: "failed",
  });
});

const projects = [{
  id: "personal-ip", name: "个人IP", status: "active", priority: 1,
  milestones: [{
    id: "content-validation", name: "验证内容方向", status: "active",
    deliverables: [{ id: "video-01", name: "发布首条短视频", status: "pending" }],
  }],
}];

const weeklyPlan = {
  outcomes: ["发布首条短视频"],
  deliverableChanges: [],
  tasks: [{
    taskId: "publish-video-01", projectId: "personal-ip", projectName: "个人IP",
    milestoneId: "content-validation", deliverableId: "video-01", title: "发布首条短视频",
    deliverable: "公开视频链接", completionStandard: "链接可访问", minutes: 120,
    date: "2026-07-13", requiresEvidence: true, impact: "normal",
  }],
};

test("returns a validated weekly plan bound to a known deliverable", async () => {
  let invocation;
  const analyzer = createCodexAnalyzer({}, { run: async (input) => {
    invocation = input;
    return JSON.stringify(weeklyPlan);
  } });
  const result = await analyzer.analyzeWeeklyPlan({ weekId: "2026-W29", projects, previousPlan: null });

  assert.equal(result.analysisStatus, "complete");
  assert.equal(result.tasks[0].deliverableId, "video-01");
  assert.equal(invocation.mode, "weekly_plan");
  assert.match(invocation.schemaPath, /codex-weekly-plan-schema\.json$/);
});

test("canonical weekly validation rejects impossible calendar dates", () => {
  const plan = structuredClone(weeklyPlan);
  plan.tasks[0].date = "2026-02-31";

  assert.throws(() => validateWeeklyPlan(plan, projects), /invalid weekly task date/);
});

test("falls back to existing pending deliverables without creating scope", async () => {
  const analyzer = createCodexAnalyzer({}, { run: async () => { throw new Error("offline"); } });
  const result = await analyzer.analyzeWeeklyPlan({ weekId: "2026-W29", projects, previousPlan: null });

  assert.equal(result.analysisStatus, "failed");
  assert.equal(result.tasks[0].deliverableId, "video-01");
  assert.equal(result.tasks[0].date, "2026-07-13");
  assert.deepEqual(result.deliverableChanges, []);
  assert.match(result.analysisError, /offline/);
});

test("rejects an unknown deliverable unless the same plan proposes it", async () => {
  const unknownPlan = structuredClone(weeklyPlan);
  unknownPlan.tasks[0].deliverableId = "video-02";
  const invalid = createCodexAnalyzer({}, { run: async () => JSON.stringify(unknownPlan) });
  assert.equal((await invalid.analyzeWeeklyPlan({ weekId: "2026-W29", projects })).analysisStatus, "failed");

  unknownPlan.deliverableChanges.push({
    action: "add", projectId: "personal-ip", milestoneId: "content-validation",
    deliverableId: "video-02", name: "发布第二条短视频", weight: 20, status: "pending",
  });
  const valid = createCodexAnalyzer({}, { run: async () => JSON.stringify(unknownPlan) });
  assert.equal((await valid.analyzeWeeklyPlan({ weekId: "2026-W29", projects })).analysisStatus, "complete");
});

test("rejects deliverable changes that reference unknown project structure", async () => {
  const plan = structuredClone(weeklyPlan);
  plan.deliverableChanges.push({
    action: "add", projectId: "personal-ip", milestoneId: "missing-milestone",
    deliverableId: "video-02", name: "发布第二条短视频", weight: 20, status: "pending",
  });
  const analyzer = createCodexAnalyzer({}, { run: async () => JSON.stringify(plan) });
  const result = await analyzer.analyzeWeeklyPlan({ weekId: "2026-W29", projects });
  assert.equal(result.analysisStatus, "failed");
  assert.match(result.analysisError, /unknown deliverable change milestone/);
});

test("weekly analysis cannot accept, add evidence to, mutate, or remove an accepted deliverable", async () => {
  const acceptedProjects = structuredClone(projects);
  acceptedProjects[0].milestones[0].deliverables[0].status = "accepted";
  acceptedProjects[0].milestones[0].deliverables[0].evidence = "https://example.com/proof";
  for (const change of [
    { action: "update", status: "doing", evidence: "forged" },
    { action: "remove", status: "accepted" },
  ]) {
    const plan = structuredClone(weeklyPlan);
    plan.tasks = [];
    plan.deliverableChanges = [{
      ...change, projectId: "personal-ip", milestoneId: "content-validation",
      deliverableId: "video-01", name: "changed", weight: 50,
    }];
    const analyzer = createCodexAnalyzer({}, { run: async () => JSON.stringify(plan) });
    const result = await analyzer.analyzeWeeklyPlan({ weekId: "2026-W29", projects: acceptedProjects });
    assert.equal(result.analysisStatus, "failed");
    assert.match(result.analysisError, /accepted deliverable/);
  }
});

test("weekly analysis forces new deliverables to pending with no evidence", async () => {
  const plan = structuredClone(weeklyPlan);
  plan.tasks[0].deliverableId = "video-02";
  plan.deliverableChanges = [{
    action: "add", projectId: "personal-ip", milestoneId: "content-validation",
    deliverableId: "video-02", name: "发布第二条短视频", weight: 20,
    status: "accepted", evidence: "forged",
  }];
  const analyzer = createCodexAnalyzer({}, { run: async () => JSON.stringify(plan) });
  const result = await analyzer.analyzeWeeklyPlan({ weekId: "2026-W29", projects });
  assert.equal(result.analysisStatus, "failed");
  assert.match(result.analysisError, /new deliverable.*pending.*empty evidence/);
});

test("weekly analysis cannot set acceptance or evidence on a pending deliverable", async () => {
  const plan = structuredClone(weeklyPlan);
  plan.tasks = [];
  plan.deliverableChanges = [{
    action: "update", projectId: "personal-ip", milestoneId: "content-validation",
    deliverableId: "video-01", name: "发布首条短视频", weight: 100,
    status: "accepted", evidence: "forged",
  }];
  const analyzer = createCodexAnalyzer({}, { run: async () => JSON.stringify(plan) });
  const result = await analyzer.analyzeWeeklyPlan({ weekId: "2026-W29", projects });
  assert.equal(result.analysisStatus, "failed");
  assert.match(result.analysisError, /cannot set accepted status or evidence/);
});

test("fallback task ids stay unique when projects reuse a deliverable id", async () => {
  const duplicateIds = [projects[0], {
    id: "jixiang-os", name: "极享OS", status: "active", priority: 2,
    milestones: [{
      id: "release", name: "发布", status: "active",
      deliverables: [{ id: "video-01", name: "发布演示视频", status: "pending" }],
    }],
  }];
  const analyzer = createCodexAnalyzer({}, { run: async () => { throw new Error("offline"); } });
  const result = await analyzer.analyzeWeeklyPlan({ weekId: "2026-W29", projects: duplicateIds });

  assert.equal(new Set(result.tasks.map((task) => task.taskId)).size, 2);
  assert.match(result.tasks[0].taskId, /2026-W29:personal-ip:content-validation:video-01/);
  assert.match(result.tasks[1].taskId, /2026-W29:jixiang-os:release:video-01/);
});

test("analyzes one interval as one batch", async () => {
  let invocation;
  const analyzer = createCodexAnalyzer({}, { run: async (input) => {
    invocation = input;
    return JSON.stringify({
      items: [{
        messageIds: ["om-1", "om-2"], category: "idea", disposition: "candidate_pool",
        title: "老板为什么要学Codex", projectId: "personal-ip", urgency: "low",
        mustBeOwner: true, estimateMinutes: 40, dueAt: null,
        nextAction: "写出一个真实成本案例", doneDefinition: "形成60秒脚本第一版",
        checkpoints: ["确定真实案例", "写出开头钩子", "完成脚本第一版"],
        rationale: "符合个人IP获客方向，但不应打断当前拍摄",
      }],
      combinedReplyContext: "一条有效选题进入候选池",
    });
  } });
  const result = await analyzer.analyzeCheckpointMessages({
    node: "09:00", workDate: "2026-07-13",
    messages: [{ messageId: "om-1" }, { messageId: "om-2" }], context: {},
  });

  assert.equal(result.analysisStatus, "complete");
  assert.equal(result.items[0].disposition, "candidate_pool");
  assert.equal(invocation.mode, "checkpoint_messages");
  assert.match(invocation.schemaPath, /codex-checkpoint-schema\.json$/);
  assert.match(invocation.prompt, /Never invent deadlines, losses, customers, owners, evidence, or attachment contents\./);
});

test("invalid AI output falls back to one candidate review per message", async () => {
  const analyzer = createCodexAnalyzer({}, { run: async () => "{}" });
  const messages = [
    { messageId: "om-9", content: { text: "想到一个功能" } },
    { messageId: "om-10", content: { attachments: [{ name: "秘密方案.pdf" }] } },
  ];
  const result = await analyzer.analyzeCheckpointMessages({
    node: "15:00", workDate: "2026-07-13", messages, context: {},
  });

  assert.equal(result.analysisStatus, "failed");
  assert.deepEqual(result.items.map((item) => item.disposition), ["candidate_pool", "candidate_pool"]);
  assert.deepEqual(result.items.map((item) => item.messageIds), [["om-9"], ["om-10"]]);
  assert.doesNotMatch(JSON.stringify(result.items[1]), /秘密方案/);
  assert.match(result.analysisError, /missing|invalid/i);
});

test("unsupported analyzer values never interrupt or schedule", async () => {
  const analyzer = createCodexAnalyzer({}, { run: async () => JSON.stringify({
    items: [{
      messageIds: ["om-11"], category: "idea", disposition: "teleport_now",
      title: "新想法", projectId: null, urgency: "high", mustBeOwner: false,
      estimateMinutes: 20, dueAt: null, nextAction: "看看", doneDefinition: "看完",
      checkpoints: ["看看"], rationale: "未知策略",
    }],
    combinedReplyContext: "立即处理",
  }) });
  const result = await analyzer.analyzeCheckpointMessages({
    node: "18:00", workDate: "2026-07-13", messages: [{ messageId: "om-11" }], context: {},
  });

  assert.equal(result.analysisStatus, "failed");
  assert.equal(result.items[0].disposition, "candidate_pool");
});

test("partial or root-extended batch output falls back for every source message", async () => {
  const analyzer = createCodexAnalyzer({}, { run: async () => JSON.stringify({
    items: [{
      messageIds: ["om-12"], category: "idea", disposition: "candidate_pool",
      title: "一个想法", projectId: null, urgency: "low", mustBeOwner: false,
      estimateMinutes: 20, dueAt: null, nextAction: "记录想法", doneDefinition: "想法已记录",
      checkpoints: ["记录想法"], rationale: "没有截止时间",
    }],
    combinedReplyContext: "已处理",
    unsupportedAction: "schedule",
  }) });
  const result = await analyzer.analyzeCheckpointMessages({
    node: "21:00", workDate: "2026-07-13",
    messages: [{ messageId: "om-12" }, { messageId: "om-13" }], context: {},
  });

  assert.equal(result.analysisStatus, "failed");
  assert.deepEqual(result.items.map((item) => item.messageIds), [["om-12"], ["om-13"]]);
  assert.ok(result.items.every((item) => item.disposition === "candidate_pool"));
});
