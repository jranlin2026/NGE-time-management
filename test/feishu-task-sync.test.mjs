import test from "node:test";
import assert from "node:assert/strict";
import { createFeishuTaskSynchronizer } from "../src/lib/feishu-task-sync.mjs";

function syncFixture({ checkpoints = [], links: linksOverride } = {}) {
  const task = { id: "task-1", title: "完成口播视频", description: "", checkpoints };
  const schedule = { blocks: [{ taskId: task.id, startsAt: "2026-07-13T02:00:00.000Z", endsAt: "2026-07-13T04:00:00.000Z" }] };
  const storedLinks = new Map();
  const links = linksOverride || {
    findFeishuLink(localTaskId, checkpointIndex) { return storedLinks.get(`${localTaskId}:${checkpointIndex}`) || null; },
    upsertFeishuLink(link) { storedLinks.set(`${link.localTaskId}:${link.checkpointIndex}`, link); return link; },
    listFeishuLinks(localTaskId) { return [...storedLinks.values()].filter((link) => link.localTaskId === localTaskId); },
  };
  const api = {
    createdParents: [], createdChildren: [], updated: [], remoteParents: [], remoteChildren: [],
    async createTask(_config, body) {
      this.createdParents.push(body);
      const task = { guid: "parent-1", client_token: body.clientToken };
      this.remoteParents.push(task);
      return { data: { task } };
    },
    async createSubtask(_config, parentGuid, body) {
      this.createdChildren.push(body);
      const task = { guid: `child-${this.createdChildren.length - 1}`, parent_guid: parentGuid, client_token: body.clientToken };
      this.remoteChildren.push(task);
      return { data: { task } };
    },
    async updateTask(_config, guid, body) { this.updated.push({ guid, body }); },
    async listTasklistTasks() { return this.remoteParents; },
    async listSubtasks() { return this.remoteChildren; },
  };
  const sync = createFeishuTaskSynchronizer({
    config: { feishuTasklistGuid: "list-1" },
    tasks: { findById(id) { return id === task.id ? task : null; } },
    links,
    api,
    scheduleForDate: () => schedule,
  });
  return { api, links, schedule, sync, task };
}

test("creates one child per local checkpoint exactly once", async () => {
  const fixture = syncFixture({ checkpoints: [{ title: "写脚本", completed: false }, { title: "拍摄", completed: false }] });
  await fixture.sync.pushSchedule({ date: "2026-07-13", schedule: fixture.schedule });
  await fixture.sync.pushSchedule({ date: "2026-07-13", schedule: fixture.schedule });
  assert.deepEqual(fixture.api.createdParents.map((item) => item.summary), ["完成口播视频"]);
  assert.deepEqual(fixture.api.createdChildren.map((item) => item.summary), ["写脚本", "拍摄"]);
  assert.deepEqual(fixture.links.listFeishuLinks("task-1").map((link) => link.checkpointIndex).sort(), [-1, 0, 1]);
});

test("pulls one child completion without completing its parent or mutating local state", async () => {
  const fixture = syncFixture({ checkpoints: [{ title: "写脚本", completed: false }, { title: "拍摄", completed: false }] });
  await fixture.sync.pushSchedule({ date: "2026-07-13", schedule: fixture.schedule });
  fixture.api.remoteParents = [{ guid: "parent-1", completed_at: "0" }];
  fixture.api.remoteChildren = [{ guid: "child-0", completed_at: "1783908000000" }, { guid: "child-1", completed_at: "0" }];

  const result = await fixture.sync.pullProgress({ date: "2026-07-13" });

  assert.deepEqual(result.completedCheckpoints, [{ localTaskId: "task-1", checkpointIndex: 0, completedAt: "2026-07-13T02:00:00.000Z" }]);
  assert.deepEqual(result.completedTasks, []);
  assert.equal(fixture.task.checkpoints[0].completed, false);
});

test("updates only when the managed snapshot changes", async () => {
  const fixture = syncFixture();
  await fixture.sync.pushSchedule({ date: "2026-07-13", schedule: fixture.schedule });
  await fixture.sync.pushSchedule({ date: "2026-07-13", schedule: fixture.schedule });
  fixture.schedule.blocks[0].endsAt = "2026-07-13T04:30:00.000Z";
  await fixture.sync.pushSchedule({ date: "2026-07-13", schedule: fixture.schedule });
  assert.deepEqual(fixture.api.updated.map((item) => item.guid), ["parent-1"]);
});

test("adopts a remotely created task after the local link write is lost", async () => {
  const storedLinks = new Map();
  let failWrite = true;
  const links = {
    findFeishuLink(localTaskId, checkpointIndex) { return storedLinks.get(`${localTaskId}:${checkpointIndex}`) || null; },
    upsertFeishuLink(link) {
      if (failWrite) { failWrite = false; throw new Error("simulated link write crash"); }
      storedLinks.set(`${link.localTaskId}:${link.checkpointIndex}`, link);
      return link;
    },
    listFeishuLinks(localTaskId) { return [...storedLinks.values()].filter((link) => link.localTaskId === localTaskId); },
  };
  const fixture = syncFixture({ links });
  await assert.rejects(fixture.sync.pushSchedule({ date: "2026-07-13", schedule: fixture.schedule }), /link write crash/);
  await fixture.sync.pushSchedule({ date: "2026-07-13", schedule: fixture.schedule });

  assert.equal(fixture.api.createdParents.length, 1);
  assert.equal(links.findFeishuLink("task-1", -1).taskGuid, "parent-1");
  assert.match(fixture.api.createdParents[0].clientToken, /^nge-[a-f0-9]{64}$/);
});

test("pulls progress only for task ids in the requested date schedule", async () => {
  const localTasks = new Map([
    ["task-13", { id: "task-13", title: "13", status: "scheduled", checkpoints: [] }],
    ["task-14", { id: "task-14", title: "14", status: "scheduled", checkpoints: [] }],
  ]);
  const linkRows = [
    { localTaskId: "task-13", checkpointIndex: -1, taskGuid: "parent-13" },
    { localTaskId: "task-14", checkpointIndex: -1, taskGuid: "parent-14" },
  ];
  const sync = createFeishuTaskSynchronizer({
    config: { feishuTasklistGuid: "list-1" },
    tasks: { findById: (id) => localTasks.get(id) },
    links: {
      findFeishuLink: (id, index) => linkRows.find((row) => row.localTaskId === id && row.checkpointIndex === index) || null,
      listFeishuLinks: (id) => linkRows.filter((row) => row.localTaskId === id),
      upsertFeishuLink() { throw new Error("not used"); },
    },
    scheduleForDate: (date) => ({ blocks: [{ taskId: date === "2026-07-13" ? "task-13" : "task-14" }] }),
    api: {
      async listTasklistTasks() {
        return [{ guid: "parent-13", completed_at: "1783908000000" }, { guid: "parent-14", completed_at: "1783994400000" }];
      },
      async listSubtasks() { return []; },
    },
  });

  const result = await sync.pullProgress({ date: "2026-07-13" });
  assert.deepEqual(result.completedTasks, [{ localTaskId: "task-13", completedAt: "2026-07-13T02:00:00.000Z" }]);
});
