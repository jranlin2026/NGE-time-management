import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createWeeklyPlanRepository } from "../src/lib/weekly-plan-repository.mjs";

let root;

test.beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "weekly-plan-"));
});

test.afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const plan = {
  outcomes: ["发布首条短视频"],
  deliverableChanges: [],
  tasks: [{
    taskId: "publish-video-01", projectId: "personal-ip", projectName: "个人IP",
    milestoneId: "content-validation", deliverableId: "video-01", title: "发布首条短视频",
    deliverable: "公开视频链接", completionStandard: "链接可访问", minutes: 120,
    date: "2026-07-13", requiresEvidence: true, impact: "normal",
  }],
};

test("writes and reads a draft, then confirms only the unchanged version", async () => {
  const timestamps = ["2026-07-12T22:00:00+08:00", "2026-07-13T07:00:00+08:00"];
  const repo = createWeeklyPlanRepository({ kbDir: root, now: () => timestamps.shift() });
  const draft = await repo.writeDraft({ weekId: "2026-W29", version: 1, plan });

  const markdown = await fs.readFile(draft.filePath, "utf8");
  assert.match(markdown, /status: draft/);
  assert.match(markdown, /\| task_id \| project_id \| project_name \| milestone_id \| deliverable_id \|/);
  assert.equal(draft.tasks[0].completionStandard, "链接可访问");
  const confirmed = await repo.confirm({
    weekId: "2026-W29", version: 1, expectedHash: draft.contentHash,
  });
  assert.equal(confirmed.status, "confirmed");
  assert.equal(confirmed.confirmedAt, "2026-07-13T07:00:00+08:00");
  assert.deepEqual((await repo.read("2026-W29")).tasks, plan.tasks);
});

test("rejects confirmation after the weekly plan changed", async () => {
  const repo = createWeeklyPlanRepository({ kbDir: root });
  const draft = await repo.writeDraft({ weekId: "2026-W29", version: 1, plan });
  await fs.appendFile(draft.filePath, "\n人工修改\n");
  await assert.rejects(() => repo.confirm({
    weekId: "2026-W29", version: 1, expectedHash: draft.contentHash,
  }), /weekly plan changed since read/);
});

test("does not overwrite a writer that recreates the plan after confirmation claims it", async () => {
  const external = "external writer won\n";
  let claimedPath;
  const repo = createWeeklyPlanRepository({
    kbDir: root,
    afterConfirmClaim: async ({ filePath }) => {
      claimedPath = filePath;
      await fs.writeFile(filePath, external, { encoding: "utf8", flag: "wx" });
    },
  });
  const draft = await repo.writeDraft({ weekId: "2026-W29", version: 1, plan });

  await assert.rejects(() => repo.confirm({
    weekId: "2026-W29", version: 1, expectedHash: draft.contentHash,
  }), /weekly plan changed during confirmation/);
  assert.equal(claimedPath, draft.filePath);
  assert.equal(await fs.readFile(draft.filePath, "utf8"), external);
});

test("restores the claimed plan when the expected hash is stale", async () => {
  const changed = "changed between read and claim\n";
  const repo = createWeeklyPlanRepository({
    kbDir: root,
    beforeConfirmClaim: async ({ filePath }) => fs.writeFile(filePath, changed, "utf8"),
  });
  const draft = await repo.writeDraft({ weekId: "2026-W29", version: 1, plan });

  await assert.rejects(() => repo.confirm({
    weekId: "2026-W29", version: 1, expectedHash: draft.contentHash,
  }), /weekly plan changed since read/);
  assert.equal(await fs.readFile(draft.filePath, "utf8"), changed);
});

test("reads and confirms a CRLF weekly plan", async () => {
  const repo = createWeeklyPlanRepository({ kbDir: root });
  const draft = await repo.writeDraft({ weekId: "2026-W29", version: 1, plan });
  const crlf = draft.rawContent.replaceAll("\n", "\r\n");
  await fs.writeFile(draft.filePath, crlf, "utf8");
  const reread = await repo.read("2026-W29");

  assert.deepEqual(reread.tasks, plan.tasks);
  const confirmed = await repo.confirm({
    weekId: "2026-W29", version: 1, expectedHash: reread.contentHash,
  });
  assert.equal(confirmed.status, "confirmed");
});
