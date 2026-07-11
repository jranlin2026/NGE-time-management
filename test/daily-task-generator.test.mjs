import assert from "node:assert/strict";
import test from "node:test";
import { createDailyTaskGenerator, isoWeekId } from "../src/lib/daily-task-generator.mjs";

test("materializes only confirmed weekly tasks for the requested date with stable linkage", async () => {
  const stored = [];
  const tasks = {
    create(input) {
      const existing = stored.find((item) => item.id === input.id);
      if (existing) return existing;
      stored.push(input);
      return input;
    },
    listAll: () => stored,
  };
  const projectOps = {
    getConfirmedWeeklyPlan: (weekId) => weekId === "2026-W29" ? ({
      plan: { tasks: [{
        taskId: "publish-video-01", projectId: "personal-ip", projectName: "个人IP",
        milestoneId: "content-validation", deliverableId: "video-01", title: "发布首条短视频",
        date: "2026-07-13", requiresEvidence: true, impact: "normal",
        minutes: 90, completionStandard: "公开视频上线",
      }, {
        taskId: "tomorrow", date: "2026-07-14", title: "明日任务",
      }] },
    }) : null,
  };
  const generator = createDailyTaskGenerator({ tasks, projectOps });

  const created = await generator.materialize({ weekId: "2026-W29", date: "2026-07-13" });
  assert.equal(created.length, 1);
  assert.equal(created[0].id, "weekly:2026-W29:publish-video-01");
  assert.equal(created[0].projectId, "personal-ip");
  assert.equal(created[0].requiresEvidence, true);
  assert.equal(created[0].doneDefinition, "公开视频上线");

  await generator.materialize({ weekId: "2026-W29", date: "2026-07-13" });
  assert.equal(tasks.listAll().filter((item) => item.deliverableId === "video-01").length, 1);
});

test("does not materialize draft or absent weekly plans", async () => {
  const generator = createDailyTaskGenerator({
    tasks: { create: () => { throw new Error("must not create"); } },
    projectOps: { getConfirmedWeeklyPlan: () => null },
  });
  assert.deepEqual(await generator.materialize({ weekId: "2026-W29", date: "2026-07-13" }), []);
});

test("derives ISO week ids across year boundaries", () => {
  assert.equal(isoWeekId("2026-07-13"), "2026-W29");
  assert.equal(isoWeekId("2027-01-01"), "2026-W53");
});
