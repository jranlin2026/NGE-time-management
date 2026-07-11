import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildDailyReview, renderDailyReview } from "../src/lib/daily-review.mjs";
import { exportDay } from "../src/lib/markdown-export.mjs";

test("builds a factual review from tasks, schedule, and events", async () => {
  const tasks = [
    { id: "a", title: "拍 3 条口播", status: "done" },
    { id: "b", title: "极享 OS 核心优化", status: "done" },
    { id: "c", title: "极享 OS 测试收尾", status: "deferred" },
  ];
  const schedule = { blocks: tasks.map((task) => ({ taskId: task.id })) };
  const events = [
    { kind: "procrastination_recorded", payload: {} },
    { kind: "schedule_replanned", payload: { reason: "no_response_2" } },
  ];
  const summary = buildDailyReview({ date: "2026-07-10", tasks, schedule, events });

  assert.deepEqual(summary, {
    date: "2026-07-10",
    criticalPlanned: 3,
    criticalCompleted: 2,
    completionRate: 67,
    procrastinationCount: 1,
    blockedCount: 0,
    deferredTitles: ["极享 OS 测试收尾"],
    tomorrowCandidates: ["极享 OS 测试收尾"],
    changes: ["no_response_2"],
    recommendation: "明天先继续最高优先级的未完成任务；开始前只看下一步动作，不重新整理全部计划。",
  });
  assert.match(renderDailyReview(summary), /完成 2\/3 个关键任务/);
  assert.match(renderDailyReview(summary), /no_response_2/);

  const exportDir = await fs.mkdtemp(path.join(os.tmpdir(), "time-manager-export-"));
  const kbDir = await fs.mkdtemp(path.join(os.tmpdir(), "time-manager-kb-"));
  const files = await exportDay({ exportDir, kbDir, date: "2026-07-10", schedule, review: summary });
  assert.match(await fs.readFile(files.reviewFile, "utf8"), /今日完成度：67%/);
  assert.match(await fs.readFile(files.planFile, "utf8"), /任务 a/);
  assert.match(await fs.readFile(files.knowledgeBaseReviewFile, "utf8"), /今日完成度：67%/);
});
