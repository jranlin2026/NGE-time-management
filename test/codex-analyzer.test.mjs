import assert from "node:assert/strict";
import test from "node:test";
import { createCodexAnalyzer, fallbackTaskAnalysis } from "../src/lib/codex-analyzer.mjs";

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
