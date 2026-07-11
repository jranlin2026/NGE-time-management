import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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

const sha256 = (content) => createHash("sha256").update(content, "utf8").digest("hex");

test("writes and reads a draft, then confirms only the unchanged version", async () => {
  const timestamps = ["2026-07-12T22:00:00+08:00", "2026-07-13T07:00:00+08:00"];
  const repo = createWeeklyPlanRepository({ kbDir: root, now: () => timestamps.shift() });
  const draft = await repo.writeDraft({ weekId: "2026-W29", version: 1, plan });

  const markdown = await fs.readFile(draft.filePath, "utf8");
  assert.match(draft.filePath, /2026-W29\.v1\.draft\.md$/);
  assert.match(markdown, /status: draft/);
  assert.match(markdown, /\| task_id \| project_id \| project_name \| milestone_id \| deliverable_id \|/);
  assert.equal(draft.tasks[0].completionStandard, "链接可访问");
  const confirmed = await repo.confirm({
    weekId: "2026-W29", version: 1, expectedHash: draft.contentHash,
  });
  assert.equal(confirmed.status, "confirmed");
  assert.match(confirmed.filePath, /周计划\/2026-W29\.md$/);
  assert.equal(confirmed.confirmedAt, "2026-07-13T07:00:00+08:00");
  assert.deepEqual((await repo.read("2026-W29")).tasks, plan.tasks);
  const repeated = await repo.confirm({
    weekId: "2026-W29", version: 1, expectedHash: draft.contentHash,
  });
  assert.equal(repeated.contentHash, confirmed.contentHash);
});

test("rejects confirmation after the weekly plan changed", async () => {
  const repo = createWeeklyPlanRepository({ kbDir: root });
  const draft = await repo.writeDraft({ weekId: "2026-W29", version: 1, plan });
  await fs.appendFile(draft.filePath, "\n人工修改\n");
  await assert.rejects(() => repo.confirm({
    weekId: "2026-W29", version: 1, expectedHash: draft.contentHash,
  }), /weekly plan changed since read/);
});

test("rejects drafts whose internal week or version differs from the requested identity", async () => {
  for (const mutate of [
    (content) => content.replace("week_id: 2026-W29", "week_id: 2026-W30"),
    (content) => content.replace("version: 1", "version: 2"),
  ]) {
    const iterationRoot = await fs.mkdtemp(path.join(root, "identity-mismatch-"));
    const repo = createWeeklyPlanRepository({ kbDir: iterationRoot });
    const draft = await repo.writeDraft({ weekId: "2026-W29", version: 1, plan });
    const changed = mutate(draft.rawContent);
    await fs.writeFile(draft.filePath, changed, "utf8");

    await assert.rejects(() => repo.confirm({
      weekId: "2026-W29", version: 1, expectedHash: sha256(changed),
    }), /weekly plan draft identity mismatch/);
    await assert.rejects(() => fs.access(path.join(iterationRoot, "周计划", "2026-W29.md")), { code: "ENOENT" });
  }
});

test("rejects a draft mutation before hash verification without publishing canonical", async () => {
  const changed = "changed before verification\n";
  const repo = createWeeklyPlanRepository({
    kbDir: root,
    beforeDraftVerification: async ({ draftPath }) => fs.writeFile(draftPath, changed, "utf8"),
  });
  const draft = await repo.writeDraft({ weekId: "2026-W29", version: 1, plan });

  await assert.rejects(() => repo.confirm({
    weekId: "2026-W29", version: 1, expectedHash: draft.contentHash,
  }), /weekly plan changed since read/);
  assert.equal(await fs.readFile(draft.filePath, "utf8"), changed);
  await assert.rejects(() => fs.access(path.join(root, "周计划", "2026-W29.md")), { code: "ENOENT" });
});

test("publishes approved bytes while preserving a later draft edit", async () => {
  const changed = "changed after approved read\n";
  const repo = createWeeklyPlanRepository({
    kbDir: root,
    afterApprovedDraftRead: async ({ draftPath }) => fs.writeFile(draftPath, changed, "utf8"),
  });
  const draft = await repo.writeDraft({ weekId: "2026-W29", version: 1, plan });
  const confirmed = await repo.confirm({
    weekId: "2026-W29", version: 1, expectedHash: draft.contentHash,
  });

  assert.equal(await fs.readFile(draft.filePath, "utf8"), changed);
  assert.equal(confirmed.status, "confirmed");
  assert.deepEqual(confirmed.tasks, plan.tasks);
  assert.doesNotMatch(confirmed.rawContent, /changed after approved read/);
});

test("publishes only through an exclusive link without removing draft or canonical", async () => {
  let observed = false;
  const repo = createWeeklyPlanRepository({
    kbDir: root,
    beforeCanonicalLink: async ({ draftPath, canonicalPath, temporaryPath }) => {
      assert.match(await fs.readFile(draftPath, "utf8"), /status: draft/);
      await assert.rejects(() => fs.access(canonicalPath), { code: "ENOENT" });
      assert.match(await fs.readFile(temporaryPath, "utf8"), /status: confirmed/);
      observed = true;
    },
  });
  const draft = await repo.writeDraft({ weekId: "2026-W29", version: 1, plan });
  await repo.confirm({ weekId: "2026-W29", version: 1, expectedHash: draft.contentHash });

  assert.equal(observed, true);
  assert.match(await fs.readFile(draft.filePath, "utf8"), /status: draft/);
  assert.match(await fs.readFile(path.join(root, "周计划", "2026-W29.md"), "utf8"), /status: confirmed/);
});

test("syncs the containing directory after link and again after temp cleanup", async () => {
  const calls = [];
  const fileSystem = {
    ...fs,
    link: async (...args) => {
      await fs.link(...args);
      calls.push("link");
    },
    rm: async (filePath, options) => {
      await fs.rm(filePath, options);
      if (filePath.endsWith(".tmp")) calls.push("remove-temp");
    },
    open: async (filePath, flags) => {
      const handle = await fs.open(filePath, flags);
      if (!filePath.endsWith(".tmp")) {
        return {
          sync: async () => { calls.push("directory-sync"); await handle.sync(); },
          close: () => handle.close(),
        };
      }
      return handle;
    },
  };
  const repo = createWeeklyPlanRepository({ kbDir: root, fileSystem });
  const draft = await repo.writeDraft({ weekId: "2026-W29", version: 1, plan });
  calls.length = 0;
  await repo.confirm({ weekId: "2026-W29", version: 1, expectedHash: draft.contentHash });

  assert.deepEqual(calls, ["link", "directory-sync", "remove-temp", "directory-sync"]);
});

test("never mutates an existing different canonical plan", async () => {
  const repo = createWeeklyPlanRepository({ kbDir: root });
  const first = await repo.writeDraft({ weekId: "2026-W29", version: 1, plan });
  const confirmed = await repo.confirm({ weekId: "2026-W29", version: 1, expectedHash: first.contentHash });
  const canonicalBytes = confirmed.rawContent;
  const second = await repo.writeDraft({ weekId: "2026-W29", version: 2, plan: { ...plan, outcomes: ["不同成果"] } });

  await assert.rejects(() => repo.confirm({
    weekId: "2026-W29", version: 2, expectedHash: second.contentHash,
  }), /confirmed weekly plan is immutable/);
  assert.equal(await fs.readFile(confirmed.filePath, "utf8"), canonicalBytes);
});

test("rejects same-plan canonical files that are not valid confirmations", async () => {
  for (const mutate of [
    (content) => content.replace("status: confirmed", "status: draft"),
    (content) => content.replace(/^confirmed_at:.*$/m, "confirmed_at: "),
    (content) => content.replace(/^confirmed_at:.*$/m, "confirmed_at: not-a-timestamp"),
  ]) {
    const iterationRoot = await fs.mkdtemp(path.join(root, "invalid-canonical-"));
    const repo = createWeeklyPlanRepository({ kbDir: iterationRoot });
    const draft = await repo.writeDraft({ weekId: "2026-W29", version: 1, plan });
    const confirmed = await repo.confirm({ weekId: "2026-W29", version: 1, expectedHash: draft.contentHash });
    await fs.writeFile(confirmed.filePath, mutate(confirmed.rawContent), "utf8");

    await assert.rejects(() => repo.confirm({
      weekId: "2026-W29", version: 1, expectedHash: draft.contentHash,
    }), /confirmed weekly plan is immutable/);
  }
});

test("reads and confirms a CRLF weekly plan", async () => {
  const repo = createWeeklyPlanRepository({ kbDir: root });
  const draft = await repo.writeDraft({ weekId: "2026-W29", version: 1, plan });
  const crlf = draft.rawContent.replaceAll("\n", "\r\n");
  await fs.writeFile(draft.filePath, crlf, "utf8");
  const reread = await repo.read("2026-W29", 1);

  assert.deepEqual(reread.tasks, plan.tasks);
  const confirmed = await repo.confirm({
    weekId: "2026-W29", version: 1, expectedHash: reread.contentHash,
  });
  assert.equal(confirmed.status, "confirmed");
});
