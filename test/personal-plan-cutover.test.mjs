import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createAutomationRepository } from "../src/db/automation-repository.mjs";
import { openDatabase } from "../src/db/database.mjs";
import { createTaskRepository } from "../src/db/task-repository.mjs";
import {
  applyPersonalPlanCutover,
  classifyPersonalPlanCutover,
  isLegacyDuplicateCandidate,
  parsePersonalPlanCutoverArgs,
  preparePersonalPlanCutover,
} from "../src/lib/personal-plan-cutover.mjs";

const WORK_DATE = "2026-07-13";
const RETAINED_ID = "retained-ip";
const OBSOLETE_ID = "obsolete-ip";
const TARGET_ID = "wk20260713-personal-ip";

test("CLI defaults to prepare, never accepts raw GUIDs and requires an explicit manifest for apply", () => {
  assert.deepEqual(parsePersonalPlanCutoverArgs([
    `--work-date=${WORK_DATE}`,
    `--retained-task-id=${RETAINED_ID}`,
    `--obsolete-task-id=${OBSOLETE_ID}`,
  ]), {
    command: "prepare",
    workDate: WORK_DATE,
    retainedLocalTaskId: RETAINED_ID,
    obsoleteLocalTaskId: OBSOLETE_ID,
    targetLocalTaskId: TARGET_ID,
  });
  assert.deepEqual(parsePersonalPlanCutoverArgs(["apply", "--manifest=/private/manifest.json"]), {
    command: "apply",
    manifestPath: "/private/manifest.json",
  });
  assert.throws(() => parsePersonalPlanCutoverArgs(["apply"]), /explicit manifest/);
  assert.throws(() => parsePersonalPlanCutoverArgs(["--guid=remote-id"]), /unsupported argument/);
  assert.throws(() => parsePersonalPlanCutoverArgs([
    `--work-date=${WORK_DATE}`,
    `--retained-task-id=${RETAINED_ID}`,
    `--obsolete-task-id=${OBSOLETE_ID}`,
    "--target-task-id=mistyped-target",
  ]), /approved consolidated target/);
});

test("legacy duplicate classification requires every safety gate", () => {
  const task = remoteParent("legacy", { allDay: true });
  const input = { task, sentLegacyGuids: new Set(["legacy"]), managedGuids: new Set(), subtasks: [] };
  assert.equal(isLegacyDuplicateCandidate(input), true);
  assert.equal(isLegacyDuplicateCandidate({ ...input, sentLegacyGuids: new Set() }), false);
  assert.equal(isLegacyDuplicateCandidate({ ...input, managedGuids: new Set(["legacy"]) }), false);
  assert.equal(isLegacyDuplicateCandidate({ ...input, task: { ...task, parent_guid: "unexpected-parent" } }), false);
  assert.equal(isLegacyDuplicateCandidate({ ...input, task: { ...task, completed_at: "1" } }), false);
  assert.equal(isLegacyDuplicateCandidate({ ...input, task: remoteParent("legacy", { allDay: false }) }), false);
  assert.equal(isLegacyDuplicateCandidate({ ...input, subtasks: [{ guid: "child" }] }), false);
});

test("preflight requires five legacy duplicates, five completed parents and both exact four-link IP trees", () => {
  const snapshot = cutoverSnapshot();
  const result = classifyPersonalPlanCutover(snapshot);
  assert.deepEqual(result.counts, {
    legacyParents: 5,
    completedHistoricalParents: 5,
    retainedLinks: 4,
    obsoleteLinks: 4,
    remoteDeletes: 9,
  });
  assert.deepEqual(result.deletionOrder.map((item) => item.kind), [
    "legacy_parent", "legacy_parent", "legacy_parent", "legacy_parent", "legacy_parent",
    "obsolete_child", "obsolete_child", "obsolete_child", "obsolete_parent",
  ]);

  assert.throws(() => classifyPersonalPlanCutover({
    ...snapshot,
    remoteParents: snapshot.remoteParents.filter((item) => item.guid !== "history-4"),
  }), /exactly five completed historical parents/);
  assert.throws(() => classifyPersonalPlanCutover({
    ...snapshot,
    managedLinks: snapshot.managedLinks.filter((item) => !(item.localTaskId === OBSOLETE_ID && item.checkpointIndex === 2)),
  }), /obsolete.*four-link tree/);
});

test("prepare is mutation-free, writes a private manifest and returns only sanitized counts and path", async (t) => {
  const fixture = await cutoverFixture(t);
  const beforeLinks = fixture.repo.listAllFeishuLinks();
  const result = await preparePersonalPlanCutover(fixture.prepareOptions);

  assert.equal(result.status, "prepared");
  assert.deepEqual(result.counts, {
    legacyParents: 5,
    completedHistoricalParents: 5,
    retainedLinks: 4,
    obsoleteLinks: 4,
    remoteDeletes: 9,
  });
  assert.deepEqual(fixture.repo.listAllFeishuLinks(), beforeLinks);
  assert.equal(fixture.api.deleteCalls.length, 0);
  assert.equal((await fs.stat(result.manifestPath)).mode & 0o777, 0o600);
  const printed = JSON.stringify(result);
  for (const guid of fixture.remoteGuids) assert.equal(printed.includes(guid), false);
});

test("apply deletes only the manifest sequence then atomically rebinds retained links", async (t) => {
  const fixture = await cutoverFixture(t);
  const prepared = await preparePersonalPlanCutover(fixture.prepareOptions);
  const expectedOrder = [
    ...fixture.legacyGuids,
    "drop-child-0", "drop-child-1", "drop-child-2", "drop-parent",
  ];

  const result = await applyPersonalPlanCutover({
    manifestPath: prepared.manifestPath,
    manifestDir: fixture.manifestDir,
    repo: fixture.repo,
    api: fixture.api,
    config: {},
    expectedWorkDate: WORK_DATE,
  });

  assert.deepEqual(fixture.api.deleteCalls, expectedOrder);
  assert.equal(fixture.api.statusCalls.length > 0, true);
  assert.deepEqual(result, {
    status: "applied",
    counts: { remoteDeleted: 9, alreadyMissing: 0, retainedLinks: 4, removedLinks: 4 },
  });
  assert.equal(fixture.repo.listFeishuLinks(RETAINED_ID).length, 0);
  assert.equal(fixture.repo.listFeishuLinks(OBSOLETE_ID).length, 0);
  assert.equal(fixture.repo.listFeishuLinks(TARGET_ID).length, 4);
  for (const guid of fixture.remoteGuids) assert.equal(JSON.stringify(result).includes(guid), false);
});

test("a partial deletion failure leaves links untouched and retrying the same manifest converges", async (t) => {
  const fixture = await cutoverFixture(t);
  const prepared = await preparePersonalPlanCutover(fixture.prepareOptions);
  fixture.api.failDeleteAt = 3;

  await assert.rejects(() => applyPersonalPlanCutover({
    manifestPath: prepared.manifestPath,
    manifestDir: fixture.manifestDir,
    repo: fixture.repo,
    api: fixture.api,
    config: {},
    expectedWorkDate: WORK_DATE,
  }), /remote deletion failed/);
  assert.equal(fixture.repo.listFeishuLinks(RETAINED_ID).length, 4);
  assert.equal(fixture.repo.listFeishuLinks(OBSOLETE_ID).length, 4);
  assert.equal(fixture.repo.listFeishuLinks(TARGET_ID).length, 0);

  fixture.api.failDeleteAt = 0;
  const retried = await applyPersonalPlanCutover({
    manifestPath: prepared.manifestPath,
    manifestDir: fixture.manifestDir,
    repo: fixture.repo,
    api: fixture.api,
    config: {},
    expectedWorkDate: WORK_DATE,
  });
  assert.equal(retried.status, "applied");
  assert.equal(retried.counts.alreadyMissing, 2);
  assert.equal(fixture.repo.listFeishuLinks(TARGET_ID).length, 4);
});

test("manifest-scoped 404 is success while other deletion errors stop", async (t) => {
  const fixture = await cutoverFixture(t);
  const prepared = await preparePersonalPlanCutover(fixture.prepareOptions);
  fixture.api.notFoundAt = 1;
  const result = await applyPersonalPlanCutover({
    manifestPath: prepared.manifestPath,
    manifestDir: fixture.manifestDir,
    repo: fixture.repo,
    api: fixture.api,
    config: {},
    expectedWorkDate: WORK_DATE,
  });
  assert.equal(result.status, "applied");
  assert.equal(result.counts.alreadyMissing, 1);
});

test("changed signatures and manifests outside the private directory are rejected without deletion", async (t) => {
  const fixture = await cutoverFixture(t);
  const prepared = await preparePersonalPlanCutover(fixture.prepareOptions);
  fixture.api.parents.find((item) => item.guid === fixture.legacyGuids[0]).summary = "changed after prepare";
  await assert.rejects(() => applyPersonalPlanCutover({
    manifestPath: prepared.manifestPath,
    manifestDir: fixture.manifestDir,
    repo: fixture.repo,
    api: fixture.api,
    config: {},
    expectedWorkDate: WORK_DATE,
  }), /remote candidate changed/);
  assert.equal(fixture.api.deleteCalls.length, 0);

  const outside = path.join(path.dirname(fixture.manifestDir), "outside.json");
  await fs.copyFile(prepared.manifestPath, outside);
  await fs.chmod(outside, 0o600);
  await assert.rejects(() => applyPersonalPlanCutover({
    manifestPath: outside,
    manifestDir: fixture.manifestDir,
    repo: fixture.repo,
    api: fixture.api,
    config: {},
    expectedWorkDate: WORK_DATE,
  }), /private cutover directory/);
});

test("apply rejects a legacy parent that gained a subtask after prepare", async (t) => {
  const fixture = await cutoverFixture(t);
  const prepared = await preparePersonalPlanCutover(fixture.prepareOptions);
  fixture.api.children[fixture.legacyGuids[0]] = [remoteChild("unexpected-legacy-child", fixture.legacyGuids[0])];
  await assert.rejects(() => applyPersonalPlanCutover({
    manifestPath: prepared.manifestPath,
    manifestDir: fixture.manifestDir,
    repo: fixture.repo,
    api: fixture.api,
    config: {},
    expectedWorkDate: WORK_DATE,
  }), /legacy candidate changed/);
  assert.equal(fixture.api.deleteCalls.length, 0);
});

test("apply rejects extra children on either managed IP tree after prepare", async (t) => {
  for (const parentGuid of ["keep-parent", "drop-parent"]) {
    const fixture = await cutoverFixture(t);
    const prepared = await preparePersonalPlanCutover(fixture.prepareOptions);
    fixture.api.children[parentGuid].push(remoteChild(`unexpected-${parentGuid}`, parentGuid));
    await assert.rejects(() => applyPersonalPlanCutover({
      manifestPath: prepared.manifestPath,
      manifestDir: fixture.manifestDir,
      repo: fixture.repo,
      api: fixture.api,
      config: {},
      expectedWorkDate: WORK_DATE,
    }), /managed tree children changed/);
    assert.equal(fixture.api.deleteCalls.length, 0);
  }
});

test("applying an already-applied manifest is a no-op", async (t) => {
  const fixture = await cutoverFixture(t);
  const prepared = await preparePersonalPlanCutover(fixture.prepareOptions);
  await applyPersonalPlanCutover({
    manifestPath: prepared.manifestPath,
    manifestDir: fixture.manifestDir,
    repo: fixture.repo,
    api: fixture.api,
    config: {},
    expectedWorkDate: WORK_DATE,
  });
  fixture.api.deleteCalls.length = 0;
  const result = await applyPersonalPlanCutover({
    manifestPath: prepared.manifestPath,
    manifestDir: fixture.manifestDir,
    repo: fixture.repo,
    api: fixture.api,
    config: {},
    expectedWorkDate: WORK_DATE,
  });
  assert.deepEqual(result, { status: "already_applied", counts: { remoteDeleted: 0, alreadyMissing: 9, retainedLinks: 4, removedLinks: 0 } });
  assert.equal(fixture.api.deleteCalls.length, 0);
});

test("apply rejects duplicate, overlapping or unsigned manifest identities before remote calls", async (t) => {
  const mutators = [
    (manifest) => {
      manifest.legacyParents[1] = { ...manifest.legacyParents[0] };
      manifest.deletionOrder[1] = { ...manifest.deletionOrder[0] };
    },
    (manifest) => {
      manifest.legacyParents[0] = { ...manifest.retainedTree.parent };
      const sorted = [...manifest.legacyParents].sort((a, b) => a.guid.localeCompare(b.guid));
      manifest.deletionOrder.splice(0, 5, ...sorted.map((item) => ({ ...item, kind: "legacy_parent" })));
    },
    (manifest) => { manifest.completedHistoricalParents[0].signature = ""; },
  ];
  for (const mutate of mutators) {
    const fixture = await cutoverFixture(t);
    const prepared = await preparePersonalPlanCutover(fixture.prepareOptions);
    const manifest = JSON.parse(await fs.readFile(prepared.manifestPath, "utf8"));
    mutate(manifest);
    await fs.writeFile(prepared.manifestPath, JSON.stringify(manifest), { mode: 0o600 });
    await assert.rejects(() => applyPersonalPlanCutover({
      manifestPath: prepared.manifestPath,
      manifestDir: fixture.manifestDir,
      repo: fixture.repo,
      api: fixture.api,
      config: {},
      expectedWorkDate: WORK_DATE,
    }), /manifest identities are invalid/);
    assert.equal(fixture.api.statusCalls.length, 0);
    assert.equal(fixture.api.deleteCalls.length, 0);
  }
});

test("apply rejects manifest trees whose serialized parents or children are not bound to their links", async (t) => {
  const mutators = [
    (manifest) => { manifest.retainedTree.parent = { ...manifest.obsoleteTree.parent }; },
    (manifest) => {
      manifest.obsoleteTree.children[0] = {
        ...manifest.legacyParents[0],
        checkpointIndex: 0,
      };
    },
    (manifest) => { manifest.completedHistoricalParents[1] = { ...manifest.completedHistoricalParents[0] }; },
    (manifest) => { manifest.deletionOrder[0].parentGuid = "redirected-parent"; },
  ];
  for (const mutate of mutators) {
    const fixture = await cutoverFixture(t);
    const prepared = await preparePersonalPlanCutover(fixture.prepareOptions);
    const manifest = JSON.parse(await fs.readFile(prepared.manifestPath, "utf8"));
    mutate(manifest);
    await fs.writeFile(prepared.manifestPath, JSON.stringify(manifest), { mode: 0o600 });
    await assert.rejects(() => applyPersonalPlanCutover({
      manifestPath: prepared.manifestPath,
      manifestDir: fixture.manifestDir,
      repo: fixture.repo,
      api: fixture.api,
      config: {},
      expectedWorkDate: WORK_DATE,
    }), /manifest (tree binding|identities|deletion sequence) (is|are) invalid/);
    assert.equal(fixture.api.statusCalls.length, 0);
    assert.equal(fixture.api.deleteCalls.length, 0);
  }
});

test("prepare and apply require the approved target task before any remote deletion", async (t) => {
  const missingAtPrepare = await cutoverFixture(t);
  missingAtPrepare.db.prepare("DELETE FROM tasks WHERE id=?").run(TARGET_ID);
  await assert.rejects(
    () => preparePersonalPlanCutover(missingAtPrepare.prepareOptions),
    /approved target task is missing/,
  );
  assert.equal(missingAtPrepare.api.statusCalls.length, 0);
  assert.equal(missingAtPrepare.api.deleteCalls.length, 0);

  const missingAtApply = await cutoverFixture(t);
  const prepared = await preparePersonalPlanCutover(missingAtApply.prepareOptions);
  missingAtApply.db.prepare("DELETE FROM tasks WHERE id=?").run(TARGET_ID);
  await assert.rejects(() => applyPersonalPlanCutover({
    manifestPath: prepared.manifestPath,
    manifestDir: missingAtApply.manifestDir,
    repo: missingAtApply.repo,
    api: missingAtApply.api,
    config: {},
    expectedWorkDate: WORK_DATE,
  }), /approved target task is missing/);
  assert.equal(missingAtApply.api.statusCalls.length, 0);
  assert.equal(missingAtApply.api.deleteCalls.length, 0);

  const disappearsBeforeDelete = await cutoverFixture(t);
  const preparedForRace = await preparePersonalPlanCutover(disappearsBeforeDelete.prepareOptions);
  const exists = disappearsBeforeDelete.repo.localTaskExists.bind(disappearsBeforeDelete.repo);
  let checks = 0;
  disappearsBeforeDelete.repo.localTaskExists = (taskId) => {
    checks += 1;
    return checks === 1 ? exists(taskId) : false;
  };
  await assert.rejects(() => applyPersonalPlanCutover({
    manifestPath: preparedForRace.manifestPath,
    manifestDir: disappearsBeforeDelete.manifestDir,
    repo: disappearsBeforeDelete.repo,
    api: disappearsBeforeDelete.api,
    config: {},
    expectedWorkDate: WORK_DATE,
  }), /approved target task is missing/);
  assert.equal(disappearsBeforeDelete.api.statusCalls.length > 0, true);
  assert.equal(disappearsBeforeDelete.api.deleteCalls.length, 0);
});

async function cutoverFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "personal-plan-cutover-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const manifestDir = path.join(root, "data", "cutover");
  const db = openDatabase(":memory:");
  t.after(() => db.close());
  const repo = createAutomationRepository(db, { now: () => "2026-07-13T00:00:00.000Z" });
  const tasks = createTaskRepository(db);
  for (const id of [RETAINED_ID, OBSOLETE_ID, TARGET_ID]) tasks.create({ id, title: id });
  const snapshot = cutoverSnapshot();
  for (const link of snapshot.managedLinks) repo.upsertFeishuLink(link);
  for (const [index, guid] of snapshot.legacyTaskGuids.entries()) {
    db.prepare(`INSERT INTO outbox
      (id,kind,payload_json,idempotency_key,status,attempts,next_attempt_at,external_id,created_at,sent_at)
      VALUES (?,?, '{}',?,'sent',0,?,?,?,?)`).run(
      `outbox-${index}`, "feishu_task_create", `legacy-${index}`, "2026-07-13T00:00:00.000Z",
      guid, "2026-07-13T00:00:00.000Z", "2026-07-13T00:00:01.000Z",
    );
  }
  const api = fakeApi(snapshot.remoteParents, snapshot.remoteChildrenByParent);
  return {
    db,
    repo,
    api,
    manifestDir,
    legacyGuids: [...snapshot.legacyTaskGuids].sort(),
    remoteGuids: [
      ...snapshot.remoteParents.map((item) => item.guid),
      ...Object.values(snapshot.remoteChildrenByParent).flat().map((item) => item.guid),
    ],
    prepareOptions: {
      workDate: WORK_DATE,
      retainedLocalTaskId: RETAINED_ID,
      obsoleteLocalTaskId: OBSOLETE_ID,
      targetLocalTaskId: TARGET_ID,
      manifestDir,
      repo,
      api,
      config: {},
      now: () => "2026-07-13T00:00:00.000Z",
    },
  };
}

function cutoverSnapshot() {
  const retainedLinks = treeLinks(RETAINED_ID, "keep");
  const obsoleteLinks = treeLinks(OBSOLETE_ID, "drop");
  const legacyTaskGuids = new Set(["legacy-0", "legacy-1", "legacy-2", "legacy-3", "legacy-4"]);
  const remoteParents = [
    remoteParent("keep-parent"),
    remoteParent("drop-parent"),
    ...[...legacyTaskGuids].map((guid) => remoteParent(guid, { allDay: true })),
    ...[0, 1, 2, 3, 4].map((index) => remoteParent(`history-${index}`, { completed: true, allDay: true })),
  ];
  const remoteChildrenByParent = {
    "keep-parent": [0, 1, 2].map((index) => remoteChild(`keep-child-${index}`, "keep-parent")),
    "drop-parent": [0, 1, 2].map((index) => remoteChild(`drop-child-${index}`, "drop-parent")),
  };
  return {
    workDate: WORK_DATE,
    retainedLocalTaskId: RETAINED_ID,
    obsoleteLocalTaskId: OBSOLETE_ID,
    targetLocalTaskId: TARGET_ID,
    remoteParents,
    remoteChildrenByParent,
    managedLinks: [...retainedLinks, ...obsoleteLinks],
    legacyTaskGuids,
  };
}

function treeLinks(localTaskId, prefix) {
  const parentGuid = `${prefix}-parent`;
  return [-1, 0, 1, 2].map((checkpointIndex) => ({
    localTaskId,
    checkpointIndex,
    taskGuid: checkpointIndex === -1 ? parentGuid : `${prefix}-child-${checkpointIndex}`,
    parentGuid: checkpointIndex === -1 ? null : parentGuid,
    snapshotHash: `${prefix}-${checkpointIndex}`,
  }));
}

function remoteParent(guid, { completed = false, allDay = false } = {}) {
  return {
    guid,
    summary: `task ${guid}`,
    completed_at: completed ? "1783908000000" : "0",
    due: { timestamp: "1783965600000", is_all_day: allDay },
  };
}

function remoteChild(guid, parentGuid) {
  return { guid, parent_guid: parentGuid, summary: `child ${guid}`, completed_at: "0" };
}

function fakeApi(remoteParents, remoteChildrenByParent) {
  const api = {
    parents: structuredClone(remoteParents),
    children: structuredClone(remoteChildrenByParent),
    deleteCalls: [],
    statusCalls: [],
    failDeleteAt: 0,
    notFoundAt: 0,
    async listTasklistTasks() { return structuredClone(this.parents); },
    async listSubtasks(_config, parentGuid) { return structuredClone(this.children[parentGuid] || []); },
    async getTask(_config, guid) {
      this.statusCalls.push(guid);
      const task = [...this.parents, ...Object.values(this.children).flat()].find((item) => item.guid === guid);
      if (!task) {
        const error = new Error("not found");
        error.status = 404;
        throw error;
      }
      return { data: { task: structuredClone(task) } };
    },
    async deleteTask(_config, guid) {
      this.deleteCalls.push(guid);
      const attempt = this.deleteCalls.length;
      if (this.failDeleteAt && attempt === this.failDeleteAt) {
        const error = new Error("remote deletion failed");
        error.status = 500;
        throw error;
      }
      removeRemote(this, guid);
      if (this.notFoundAt && attempt === this.notFoundAt) {
        const error = new Error("not found");
        error.status = 404;
        throw error;
      }
      return { code: 0 };
    },
  };
  return api;
}

function removeRemote(api, guid) {
  api.parents = api.parents.filter((item) => item.guid !== guid);
  for (const [parentGuid, children] of Object.entries(api.children)) {
    api.children[parentGuid] = children.filter((item) => item.guid !== guid);
  }
}
