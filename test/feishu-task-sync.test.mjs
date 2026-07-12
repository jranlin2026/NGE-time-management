import test from "node:test";
import assert from "node:assert/strict";
import { createFeishuTaskSynchronizer } from "../src/lib/feishu-task-sync.mjs";

function syncFixture({ checkpoints = [] } = {}) {
  const task = { id: "task-1", title: "完成口播视频", description: "", checkpoints };
  const schedule = { blocks: [{ taskId: task.id, startsAt: "2026-07-13T02:00:00.000Z", endsAt: "2026-07-13T04:00:00.000Z" }] };
  const storedLinks = new Map();
  const links = {
    findFeishuLink(localTaskId, checkpointIndex) { return storedLinks.get(`${localTaskId}:${checkpointIndex}`) || null; },
    upsertFeishuLink(link) { storedLinks.set(`${link.localTaskId}:${link.checkpointIndex}`, link); return link; },
    listFeishuLinks(localTaskId) { return [...storedLinks.values()].filter((link) => link.localTaskId === localTaskId); },
  };
  const api = {
    createdParents: [], createdChildren: [], updated: [], remoteParents: [], remoteChildren: [],
    async createTask(_config, body) { this.createdParents.push(body); return { data: { task: { guid: "parent-1" } } }; },
    async createSubtask(_config, parentGuid, body) { this.createdChildren.push(body); return { data: { task: { guid: `child-${this.createdChildren.length - 1}`, parent_guid: parentGuid } } }; },
    async updateTask(_config, guid, body) { this.updated.push({ guid, body }); },
    async listTasklistTasks() { return this.remoteParents; },
    async listSubtasks() { return this.remoteChildren; },
  };
  const sync = createFeishuTaskSynchronizer({
    config: { feishuTasklistGuid: "list-1" },
    tasks: { findById(id) { return id === task.id ? task : null; } },
    links,
    api,
    clock: () => new Date("2026-07-13T05:00:00.000Z"),
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
