import test from "node:test";
import assert from "node:assert/strict";
import { createFeishuTaskSynchronizer } from "../src/lib/feishu-task-sync.mjs";
import { buildTaskBody, buildTaskUpdateBody } from "../src/lib/feishu-tasks.mjs";

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

function detailedSyncFixture({ localTasks, schedule }) {
  const taskById = new Map(localTasks.map((task) => [task.id, task]));
  const storedLinks = new Map();
  const remoteChildren = new Map();
  const links = {
    findFeishuLink(localTaskId, checkpointIndex) { return storedLinks.get(`${localTaskId}:${checkpointIndex}`) || null; },
    upsertFeishuLink(link) { storedLinks.set(`${link.localTaskId}:${link.checkpointIndex}`, link); return link; },
    listFeishuLinks(localTaskId) { return [...storedLinks.values()].filter((link) => link.localTaskId === localTaskId); },
    listAllFeishuLinks() { return [...storedLinks.values()]; },
  };
  const api = {
    createdParents: [], createdChildren: [], updated: [], remoteParents: [],
    async createTask(_config, body) {
      this.createdParents.push(body);
      const task = { guid: `parent-${this.createdParents.length}`, client_token: body.clientToken };
      this.remoteParents.push(task);
      return { data: { task } };
    },
    async createSubtask(_config, parentGuid, body) {
      this.createdChildren.push({ parentGuid, ...body });
      const children = remoteChildren.get(parentGuid) || [];
      const task = { guid: `${parentGuid}-child-${children.length + 1}`, parent_guid: parentGuid, client_token: body.clientToken };
      children.push(task);
      remoteChildren.set(parentGuid, children);
      return { data: { task } };
    },
    async updateTask(_config, guid, body) { this.updated.push({ guid, body }); },
    async listTasklistTasks() { return this.remoteParents; },
    async listSubtasks(_config, parentGuid) { return remoteChildren.get(parentGuid) || []; },
  };
  const sync = createFeishuTaskSynchronizer({
    config: { feishuTasklistGuid: "list-1" },
    tasks: {
      findById(id) { return taskById.get(id) || null; },
      listActive() { return [...taskById.values()].filter((task) => !["done", "cancelled"].includes(task.status)); },
    },
    links,
    api,
    scheduleForDate: () => schedule,
  });
  return { api, links, schedule, sync };
}

test("clears a due-today linked outcome and unfinished children when the outcome leaves the schedule", async () => {
  const removedTask = {
    id: "task-ip",
    title: "个人IP｜交付3条可剪辑原片",
    project: "个人IP",
    nextAction: "确定3个选题",
    estimateMinutes: 60,
    dueAt: "2026-07-13",
    doneDefinition: "3条原片可剪辑",
    status: "scheduled",
    checkpoints: [
      { title: "确定3个选题", minutes: 20, doneDefinition: "3个选题已确认", completed: false },
      { title: "完成脚本", minutes: 40, doneDefinition: "脚本可直接口播", completed: false },
    ],
  };
  const retainedTask = {
    id: "task-os",
    title: "极享OS｜完成线索模块验收",
    project: "极享OS",
    nextAction: "核对字段",
    estimateMinutes: 45,
    dueAt: "2026-07-13",
    doneDefinition: "一名员工完成真实录入",
    status: "scheduled",
    checkpoints: [
      { title: "核对字段", minutes: 45, doneDefinition: "字段和权限已确认", completed: false },
    ],
  };
  const schedule = {
    blocks: [
      { taskId: "task-ip", checkpointIndex: 0, startsAt: "2026-07-13T02:00:00.000Z", endsAt: "2026-07-13T02:20:00.000Z" },
      { taskId: "task-ip", checkpointIndex: 1, startsAt: "2026-07-13T02:20:00.000Z", endsAt: "2026-07-13T03:00:00.000Z" },
      { taskId: "task-os", checkpointIndex: 0, startsAt: "2026-07-13T06:00:00.000Z", endsAt: "2026-07-13T06:45:00.000Z" },
    ],
  };
  const fixture = detailedSyncFixture({ localTasks: [removedTask, retainedTask], schedule });

  await fixture.sync.pushSchedule({ date: "2026-07-13", schedule });
  schedule.blocks = schedule.blocks.filter((block) => block.taskId === "task-os");
  await fixture.sync.pushSchedule({ date: "2026-07-13", schedule });

  assert.deepEqual(fixture.api.updated.map(({ guid, body }) => [guid, buildTaskUpdateBody(body)]), [
    ["parent-1", {
      task: {
        summary: removedTask.title,
        description: fixture.api.updated[0].body.description,
        start: null,
        due: null,
      },
      update_fields: ["summary", "description", "start", "due"],
    }],
    ["parent-1-child-1", {
      task: {
        summary: "确定3个选题",
        description: fixture.api.updated[1].body.description,
        start: null,
        due: null,
      },
      update_fields: ["summary", "description", "start", "due"],
    }],
    ["parent-1-child-2", {
      task: {
        summary: "完成脚本",
        description: fixture.api.updated[2].body.description,
        start: null,
        due: null,
      },
      update_fields: ["summary", "description", "start", "due"],
    }],
  ]);

  const updatesAfterClear = fixture.api.updated.length;
  await fixture.sync.pushSchedule({ date: "2026-07-13", schedule });
  assert.equal(fixture.api.updated.length, updatesAfterClear);
  assert.equal(fixture.api.createdParents.length, 2);
  assert.equal(fixture.api.createdChildren.length, 3);
});

test("clears a removed linked outcome with no local due date using its remote today interval", async () => {
  const removedTask = {
    id: "task-no-due",
    title: "个人IP｜完成今日拍摄",
    project: "个人IP",
    nextAction: "确认选题",
    estimateMinutes: 40,
    dueAt: null,
    doneDefinition: "完成今日拍摄",
    status: "scheduled",
    checkpoints: [
      {
        title: "确认选题",
        minutes: 20,
        startsAt: "2026-07-13T02:00:00.000Z",
        endsAt: "2026-07-13T02:20:00.000Z",
        completed: true,
      },
      { title: "拍摄原片", minutes: 20, completed: false },
    ],
  };
  const schedule = { blocks: [
    { taskId: removedTask.id, checkpointIndex: 0, startsAt: "2026-07-13T02:00:00.000Z", endsAt: "2026-07-13T02:20:00.000Z" },
    { taskId: removedTask.id, checkpointIndex: 1, startsAt: "2026-07-13T02:20:00.000Z", endsAt: "2026-07-13T02:40:00.000Z" },
  ] };
  const fixture = detailedSyncFixture({ localTasks: [removedTask], schedule });

  await fixture.sync.pushSchedule({ date: "2026-07-13", schedule });
  fixture.api.remoteParents[0].start = { timestamp: String(Date.parse("2026-07-13T02:00:00.000Z")), is_all_day: false };
  fixture.api.remoteParents[0].due = { timestamp: String(Date.parse("2026-07-13T02:40:00.000Z")), is_all_day: false };
  schedule.blocks = [];
  await fixture.sync.pushSchedule({ date: "2026-07-13", schedule });

  assert.deepEqual(fixture.api.updated.map((item) => item.guid), ["parent-1", "parent-1-child-2"]);
  for (const update of fixture.api.updated) {
    const body = buildTaskUpdateBody(update.body);
    assert.equal(body.task.start, null);
    assert.equal(body.task.due, null);
  }
  assert.equal(fixture.api.createdChildren[0].startAt, "2026-07-13T02:00:00.000Z");
  assert.equal(fixture.api.createdChildren[0].dueAt, "2026-07-13T02:20:00.000Z");
});

test("clears a removed linked outcome from its remote today interval after local due date changes", async () => {
  const removedTask = {
    id: "task-moved-due",
    title: "极享OS｜完成今日验收",
    project: "极享OS",
    nextAction: "抽测主流程",
    estimateMinutes: 30,
    dueAt: "2026-07-13",
    doneDefinition: "今日验收完成",
    status: "scheduled",
    checkpoints: [{ title: "抽测主流程", minutes: 30, completed: false }],
  };
  const schedule = { blocks: [{
    taskId: removedTask.id,
    checkpointIndex: 0,
    startsAt: "2026-07-13T06:00:00.000Z",
    endsAt: "2026-07-13T06:30:00.000Z",
  }] };
  const fixture = detailedSyncFixture({ localTasks: [removedTask], schedule });

  await fixture.sync.pushSchedule({ date: "2026-07-13", schedule });
  fixture.api.remoteParents[0].start = { timestamp: String(Date.parse("2026-07-13T06:00:00.000Z")), is_all_day: false };
  fixture.api.remoteParents[0].due = { timestamp: String(Date.parse("2026-07-13T06:30:00.000Z")), is_all_day: false };
  removedTask.dueAt = "2026-07-14";
  schedule.blocks = [];
  await fixture.sync.pushSchedule({ date: "2026-07-13", schedule });

  assert.deepEqual(fixture.api.updated.map((item) => item.guid), ["parent-1", "parent-1-child-1"]);
  assert.deepEqual(buildTaskUpdateBody(fixture.api.updated[0].body).task.start, null);
  assert.deepEqual(buildTaskUpdateBody(fixture.api.updated[0].body).task.due, null);
});

test("does not clear a removed linked outcome whose remote interval belongs to a future day", async () => {
  const futureTask = {
    id: "task-future",
    title: "个人IP｜准备明日选题",
    project: "个人IP",
    nextAction: "列出选题",
    estimateMinutes: 30,
    dueAt: null,
    doneDefinition: "明日选题已准备",
    status: "scheduled",
    checkpoints: [{ title: "列出明日选题", minutes: 30, completed: false }],
  };
  const schedule = { blocks: [{
    taskId: futureTask.id,
    checkpointIndex: 0,
    startsAt: "2026-07-14T02:00:00.000Z",
    endsAt: "2026-07-14T02:30:00.000Z",
  }] };
  const fixture = detailedSyncFixture({ localTasks: [futureTask], schedule });

  await fixture.sync.pushSchedule({ date: "2026-07-14", schedule });
  fixture.api.remoteParents[0].start = { timestamp: String(Date.parse("2026-07-14T02:00:00.000Z")), is_all_day: false };
  fixture.api.remoteParents[0].due = { timestamp: String(Date.parse("2026-07-14T02:30:00.000Z")), is_all_day: false };
  schedule.blocks = [];
  await fixture.sync.pushSchedule({ date: "2026-07-13", schedule });

  assert.deepEqual(fixture.api.updated, []);
});

test("syncs each outcome once with detailed parent fields and its own timed checkpoint children", async () => {
  const fixture = detailedSyncFixture({
    localTasks: [
      {
        id: "task-ip",
        title: "个人IP｜交付3条可剪辑原片",
        project: "个人IP",
        nextAction: "确定3个选题",
        estimateMinutes: 105,
        doneDefinition: "3条原片可剪辑",
        status: "scheduled",
        checkpoints: [
          { title: "确定3个选题", minutes: 20, doneDefinition: "3个选题和钩子已确认", feedback: "附选题清单", completed: false },
          { title: "完成脚本提纲", minutes: 40, doneDefinition: "3条提纲可直接口播", completed: false },
          { title: "完成拍摄", minutes: 45, doneDefinition: "3条原片已交剪辑", completed: false },
        ],
      },
      {
        id: "task-os",
        title: "极享OS｜完成线索模块验收",
        project: "极享OS",
        nextAction: "核对字段",
        estimateMinutes: 45,
        doneDefinition: "一名员工完成真实录入",
        status: "scheduled",
        checkpoints: [
          { title: "核对字段", minutes: 45, doneDefinition: "字段和权限已确认", completed: false },
        ],
      },
    ],
    schedule: {
      blocks: [
        { taskId: "task-ip", checkpointIndex: 0, startsAt: "2026-07-13T02:15:00.000Z", endsAt: "2026-07-13T02:35:00.000Z" },
        { taskId: "task-ip", checkpointIndex: 1, startsAt: "2026-07-13T02:35:00.000Z", endsAt: "2026-07-13T03:15:00.000Z" },
        { taskId: "task-os", checkpointIndex: 0, startsAt: "2026-07-13T03:15:00.000Z", endsAt: "2026-07-13T04:00:00.000Z" },
        { taskId: "task-ip", checkpointIndex: 2, startsAt: "2026-07-13T10:30:00.000Z", endsAt: "2026-07-13T11:15:00.000Z" },
      ],
    },
  });

  const first = await fixture.sync.pushSchedule({ date: "2026-07-13", schedule: fixture.schedule });
  const countsAfterFirstPush = {
    parents: fixture.api.createdParents.length,
    children: fixture.api.createdChildren.length,
    updates: fixture.api.updated.length,
  };
  const second = await fixture.sync.pushSchedule({ date: "2026-07-13", schedule: fixture.schedule });

  assert.deepEqual(first.tasks.map((item) => item.localTaskId), ["task-ip", "task-os"]);
  assert.deepEqual(second.tasks.map((item) => item.localTaskId), ["task-ip", "task-os"]);
  assert.deepEqual(countsAfterFirstPush, { parents: 2, children: 4, updates: 0 });
  assert.deepEqual({
    parents: fixture.api.createdParents.length,
    children: fixture.api.createdChildren.length,
    updates: fixture.api.updated.length,
  }, countsAfterFirstPush);

  const ipParent = fixture.api.createdParents.find((item) => item.summary.startsWith("个人IP"));
  assert.match(ipParent.description, /项目：个人IP/);
  assert.match(ipParent.description, /第一步：确定3个选题/);
  assert.match(ipParent.description, /预计投入：105分钟/);
  assert.match(ipParent.description, /完成标准：3条原片可剪辑/);
  assert.equal(ipParent.startAt, "2026-07-13T02:15:00.000Z");
  assert.equal(ipParent.dueAt, "2026-07-13T11:15:00.000Z");

  const ipChildren = fixture.api.createdChildren.filter((item) => item.parentGuid === "parent-1");
  assert.deepEqual(ipChildren.map((item) => item.summary), [
    "10:15–10:35｜确定3个选题",
    "10:35–11:15｜完成脚本提纲",
    "18:30–19:15｜完成拍摄",
  ]);
  assert.deepEqual(ipChildren.map((item) => [item.startAt, item.dueAt]), [
    ["2026-07-13T02:15:00.000Z", "2026-07-13T02:35:00.000Z"],
    ["2026-07-13T02:35:00.000Z", "2026-07-13T03:15:00.000Z"],
    ["2026-07-13T10:30:00.000Z", "2026-07-13T11:15:00.000Z"],
  ]);
  assert.match(ipChildren[0].description, /预计：20分钟/);
  assert.match(ipChildren[0].description, /完成标准：3个选题和钩子已确认/);
  assert.match(ipChildren[0].description, /反馈：附选题清单/);

  const osParent = fixture.api.createdParents.find((item) => item.summary.startsWith("极享OS"));
  assert.equal(osParent.startAt, "2026-07-13T03:15:00.000Z");
  assert.equal(osParent.dueAt, "2026-07-13T04:00:00.000Z");
});

test("keeps a completed checkpoint child on its stored explicit interval when it is absent from the remaining schedule", async () => {
  const fixture = detailedSyncFixture({
    localTasks: [{
      id: "task-ip",
      title: "个人IP｜交付3条可剪辑原片",
      project: "个人IP",
      nextAction: "继续完成脚本",
      estimateMinutes: 60,
      doneDefinition: "3条原片可剪辑",
      status: "scheduled",
      checkpoints: [
        {
          title: "确定3个选题",
          minutes: 20,
          startsAt: "2026-07-13T02:00:00.000Z",
          endsAt: "2026-07-13T02:20:00.000Z",
          doneDefinition: "3个选题已确认",
          completed: true,
        },
        { title: "完成脚本", minutes: 40, doneDefinition: "脚本可直接口播", completed: false },
      ],
    }],
    schedule: {
      blocks: [
        { taskId: "task-ip", checkpointIndex: 1, startsAt: "2026-07-13T02:30:00.000Z", endsAt: "2026-07-13T03:10:00.000Z" },
      ],
    },
  });

  await fixture.sync.pushSchedule({ date: "2026-07-13", schedule: fixture.schedule });

  assert.deepEqual(fixture.api.createdChildren.map((item) => [item.startAt, item.dueAt]), [
    ["2026-07-13T02:00:00.000Z", "2026-07-13T02:20:00.000Z"],
    ["2026-07-13T02:30:00.000Z", "2026-07-13T03:10:00.000Z"],
  ]);
  assert.ok(fixture.api.createdChildren[0].completedAt);
  assert.equal(fixture.api.createdParents[0].startAt, "2026-07-13T02:00:00.000Z");
  assert.equal(fixture.api.createdParents[0].dueAt, "2026-07-13T03:10:00.000Z");
});

test("does not reuse a stored future interval for an incomplete checkpoint absent from the schedule", async () => {
  const fixture = detailedSyncFixture({
    localTasks: [{
      id: "task-ip",
      title: "个人IP｜交付3条可剪辑原片",
      project: "个人IP",
      nextAction: "完成今日脚本",
      estimateMinutes: 40,
      doneDefinition: "今日脚本可直接口播",
      status: "scheduled",
      checkpoints: [
        { title: "完成今日脚本", minutes: 40, doneDefinition: "脚本可直接口播", completed: false },
        {
          title: "准备明日选题",
          minutes: 20,
          startsAt: "2026-07-14T02:00:00.000Z",
          endsAt: "2026-07-14T02:20:00.000Z",
          doneDefinition: "明日选题已准备",
          completed: false,
        },
      ],
    }],
    schedule: {
      blocks: [
        { taskId: "task-ip", checkpointIndex: 0, startsAt: "2026-07-13T02:30:00.000Z", endsAt: "2026-07-13T03:10:00.000Z" },
      ],
    },
  });

  await fixture.sync.pushSchedule({ date: "2026-07-13", schedule: fixture.schedule });

  assert.equal(fixture.api.createdChildren[1].startAt, null);
  assert.equal(fixture.api.createdChildren[1].dueAt, null);
  const initialCreate = buildTaskBody({}, fixture.api.createdChildren[1], { includeTasklist: false });
  assert.equal("start" in initialCreate, false);
  assert.equal("due" in initialCreate, false);
  assert.equal(fixture.api.createdParents[0].dueAt, "2026-07-13T03:10:00.000Z");
});

test("explicitly clears a linked incomplete child's stale remote interval when its block leaves the remaining schedule", async () => {
  const schedule = {
    blocks: [
      { taskId: "task-ip", checkpointIndex: 0, startsAt: "2026-07-13T02:00:00.000Z", endsAt: "2026-07-13T02:20:00.000Z" },
      { taskId: "task-ip", checkpointIndex: 1, startsAt: "2026-07-13T02:20:00.000Z", endsAt: "2026-07-13T03:00:00.000Z" },
    ],
  };
  const fixture = detailedSyncFixture({
    localTasks: [{
      id: "task-ip",
      title: "个人IP｜交付3条可剪辑原片",
      project: "个人IP",
      nextAction: "确定3个选题",
      estimateMinutes: 60,
      doneDefinition: "3条原片可剪辑",
      status: "scheduled",
      checkpoints: [
        { title: "确定3个选题", minutes: 20, doneDefinition: "3个选题已确认", completed: false },
        { title: "完成脚本", minutes: 40, doneDefinition: "脚本可直接口播", completed: false },
      ],
    }],
    schedule,
  });

  await fixture.sync.pushSchedule({ date: "2026-07-13", schedule });
  schedule.blocks = schedule.blocks.slice(0, 1);
  await fixture.sync.pushSchedule({ date: "2026-07-13", schedule });

  const childClear = fixture.api.updated.find((item) => item.guid === "parent-1-child-2");
  assert.ok(childClear);
  assert.deepEqual(buildTaskUpdateBody(childClear.body), {
    task: {
      summary: "完成脚本",
      description: childClear.body.description,
      start: null,
      due: null,
    },
    update_fields: ["summary", "description", "start", "due"],
  });

  const updatesAfterClear = fixture.api.updated.length;
  await fixture.sync.pushSchedule({ date: "2026-07-13", schedule });
  assert.equal(fixture.api.updated.length, updatesAfterClear);
});

test("renders a child ending at next-day midnight as 24:00", async () => {
  const fixture = detailedSyncFixture({
    localTasks: [{
      id: "task-live",
      title: "公域直播｜完成30单结果复盘",
      project: "公域直播",
      nextAction: "记录成交结果",
      estimateMinutes: 30,
      doneDefinition: "订单、差距和纠偏动作已记录",
      status: "scheduled",
      checkpoints: [{ title: "记录订单和差距", minutes: 30, doneDefinition: "复盘已记录", completed: false }],
    }],
    schedule: {
      blocks: [{
        taskId: "task-live",
        checkpointIndex: 0,
        startsAt: "2026-07-13T15:30:00.000Z",
        endsAt: "2026-07-13T16:00:00.000Z",
      }],
    },
  });

  await fixture.sync.pushSchedule({ date: "2026-07-13", schedule: fixture.schedule });

  assert.equal(fixture.api.createdChildren[0].summary, "23:30–24:00｜记录订单和差距");
});

test("creates one child per local checkpoint exactly once", async () => {
  const fixture = syncFixture({ checkpoints: [{ title: "写脚本", completed: false }, { title: "拍摄", completed: false }] });
  await fixture.sync.pushSchedule({ date: "2026-07-13", schedule: fixture.schedule });
  await fixture.sync.pushSchedule({ date: "2026-07-13", schedule: fixture.schedule });
  assert.deepEqual(fixture.api.createdParents.map((item) => item.summary), ["完成口播视频"]);
  assert.deepEqual(fixture.api.createdChildren.map((item) => item.summary), ["写脚本", "拍摄"]);
  assert.doesNotMatch(fixture.api.createdParents[0].description, /undefined|null/);
  assert.deepEqual(fixture.links.listFeishuLinks("task-1").map((link) => link.checkpointIndex).sort(), [-1, 0, 1]);
});

test("records a child when Feishu returns it under data.subtask", async () => {
  const fixture = syncFixture({ checkpoints: [{ title: "写脚本", completed: false }] });
  fixture.api.createSubtask = async function createSubtask(_config, parentGuid, body) {
    this.createdChildren.push(body);
    const subtask = { guid: "child-subtask-shape", parent_guid: parentGuid, client_token: body.clientToken };
    this.remoteChildren.push(subtask);
    return { data: { subtask } };
  };

  await fixture.sync.pushSchedule({ date: "2026-07-13", schedule: fixture.schedule });

  assert.equal(fixture.links.findFeishuLink("task-1", 0).taskGuid, "child-subtask-shape");
});

test("pulls one child completion without completing its parent or mutating local state", async () => {
  const fixture = syncFixture({ checkpoints: [{ title: "写脚本", completed: false }, { title: "拍摄", completed: false }] });
  await fixture.sync.pushSchedule({ date: "2026-07-13", schedule: fixture.schedule });
  fixture.api.remoteParents = [{ guid: "parent-1", completed_at: "0" }];
  fixture.api.remoteChildren = [{ guid: "child-0", completed_at: "1783908000000" }, { guid: "child-1", completed_at: "0" }];

  const result = await fixture.sync.pullProgress({ date: "2026-07-13" });

  assert.deepEqual(result.completedCheckpoints, [{ localTaskId: "task-1", checkpointIndex: 0, taskGuid: "child-0", completedAt: "2026-07-13T02:00:00.000Z" }]);
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

test("updates an adopted remote task before persisting the current snapshot", async () => {
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
  fixture.schedule.blocks[0].endsAt = "2026-07-13T04:30:00.000Z";
  await fixture.sync.pushSchedule({ date: "2026-07-13", schedule: fixture.schedule });

  assert.equal(fixture.api.createdParents.length, 1);
  assert.equal(fixture.api.updated[0].guid, "parent-1");
  assert.equal(fixture.api.updated[0].body.clientToken, fixture.api.createdParents[0].clientToken);
  assert.match(fixture.api.updated[0].body.description, /\[nge-managed:/);
  assert.equal(fixture.api.updated[0].body.dueAt, "2026-07-13T04:30:00.000Z");
  assert.equal(links.findFeishuLink("task-1", -1).taskGuid, "parent-1");
  assert.match(fixture.api.createdParents[0].clientToken, /^nge-[a-f0-9]{64}$/);
  await fixture.sync.pushSchedule({ date: "2026-07-13", schedule: fixture.schedule });
  assert.equal(fixture.api.updated.length, 1);
});

test("adopts a crash-created parent by managed description marker when list omits client_token", async () => {
  const fixture = syncFixture();
  let fail = true;
  const original = fixture.links.upsertFeishuLink;
  fixture.links.upsertFeishuLink = (link) => {
    if (fail) { fail = false; throw new Error("simulated link write crash"); }
    return original.call(fixture.links, link);
  };
  await assert.rejects(fixture.sync.pushSchedule({ date: "2026-07-13", schedule: fixture.schedule }), /link write crash/);
  fixture.api.remoteParents = [{ guid: "parent-1", description: fixture.api.createdParents[0].description }];
  await fixture.sync.pushSchedule({ date: "2026-07-13", schedule: fixture.schedule });
  assert.equal(fixture.api.createdParents.length, 1);
  assert.match(fixture.api.remoteParents[0].description, /\[nge-managed:[a-f0-9]{32}\]/);
});

test("adopts a crash-created child by managed description marker when list omits client_token", async () => {
  const fixture = syncFixture({ checkpoints: [{ title: "写脚本", completed: false }] });
  const original = fixture.links.upsertFeishuLink;
  let writes = 0;
  fixture.links.upsertFeishuLink = (link) => {
    writes += 1;
    if (writes === 2) throw new Error("simulated child link write crash");
    return original.call(fixture.links, link);
  };
  await assert.rejects(fixture.sync.pushSchedule({ date: "2026-07-13", schedule: fixture.schedule }), /child link write crash/);
  fixture.api.remoteChildren = [{ guid: "child-0", parent_guid: "parent-1", description: fixture.api.createdChildren[0].description }];
  await fixture.sync.pushSchedule({ date: "2026-07-13", schedule: fixture.schedule });
  assert.equal(fixture.api.createdChildren.length, 1);
  assert.equal(fixture.links.findFeishuLink("task-1", 0).taskGuid, "child-0");
});

test("pushes completed child and accepted parent states but not pending acceptance", async () => {
  const fixture = syncFixture({ checkpoints: [{ title: "写脚本", completed: true }] });
  fixture.task.status = "done";
  await fixture.sync.pushSchedule({ date: "2026-07-13", schedule: fixture.schedule });
  assert.ok(fixture.api.createdParents[0].completedAt);
  assert.ok(fixture.api.createdChildren[0].completedAt);
  const pending = syncFixture();
  pending.task.status = "pending_acceptance";
  await pending.sync.pushSchedule({ date: "2026-07-13", schedule: pending.schedule });
  assert.equal(pending.api.createdParents[0].completedAt, undefined);
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
  assert.deepEqual(result.completedTasks, [{ localTaskId: "task-13", taskGuid: "parent-13", completedAt: "2026-07-13T02:00:00.000Z" }]);
});
