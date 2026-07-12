import assert from "node:assert/strict";
import test from "node:test";
import {
  renderDailyExecutionBrief,
  renderPlanDelta,
} from "../src/lib/daily-execution-brief.mjs";

const DATE = "2026-07-13";
const TIMEZONE = "Asia/Shanghai";

test("renders one executable brief with four personal outcomes and a chronological timeline", () => {
  const tasks = approvedTasks();
  const schedule = {
    date: DATE,
    deferred: [],
    blocks: [
      block("public-live", 0, "2026-07-13T02:00:00.000Z", "2026-07-13T02:15:00.000Z"),
      block("personal-ip", 0, "2026-07-13T02:15:00.000Z", "2026-07-13T02:35:00.000Z"),
      block("personal-ip", 1, "2026-07-13T02:35:00.000Z", "2026-07-13T03:15:00.000Z"),
      block("personal-ip", 2, "2026-07-13T03:15:00.000Z", "2026-07-13T04:00:00.000Z"),
      block("jxos", 0, "2026-07-13T06:00:00.000Z", "2026-07-13T06:30:00.000Z"),
      block("jxos", 1, "2026-07-13T06:30:00.000Z", "2026-07-13T07:15:00.000Z"),
      block("jxos", 2, "2026-07-13T07:15:00.000Z", "2026-07-13T08:00:00.000Z"),
      block("public-live", 1, "2026-07-13T10:00:00.000Z", "2026-07-13T10:15:00.000Z"),
      block("personal-ip", 3, "2026-07-13T10:30:00.000Z", "2026-07-13T11:00:00.000Z"),
      block("private-live", 0, "2026-07-13T12:00:00.000Z", "2026-07-13T12:20:00.000Z"),
      block("private-live", 1, "2026-07-13T12:20:00.000Z", "2026-07-13T12:40:00.000Z"),
      block("private-live", 2, "2026-07-13T12:40:00.000Z", "2026-07-13T13:00:00.000Z"),
      block("public-live", 2, "2026-07-13T15:30:00.000Z", "2026-07-13T16:00:00.000Z"),
    ],
  };

  const text = renderDailyExecutionBrief({
    date: DATE,
    schedule,
    tasks,
    timezone: TIMEZONE,
    feedbackNodes: ["12:00", "15:00", "18:00", "21:00", "24:00"],
    doNotDo: ["不研究出海", "不新增项目"],
  });

  assert.match(text, /【7月13日执行令｜今天只完成4个结果】/);
  assert.match(text, /10:00–10:15｜确认三主播排班、货盘和成交口径/);
  assert.match(text, /14:00–14:30｜确认线索字段、权限与操作流程/);
  assert.match(text, /完成标准：1名员工完成真实线索操作/);
  assert.match(text, /12:00–14:00｜午休，不安排任务/);
  assert.match(text, /今天不做/);
  assert.match(text, /反馈节点：12:00、15:00、18:00、21:00、24:00/);
  assert.match(text, /卡住：任务名｜原因/);
  assert.doesNotMatch(text, /你直播14小时|你完成直播30单/);
});

test("lists a multi-block parent once while rendering every checkpoint in global time order", () => {
  const tasks = approvedTasks().slice(0, 2);
  const schedule = {
    date: DATE,
    blocks: [
      block("personal-ip", 3, "2026-07-13T10:30:00.000Z", "2026-07-13T11:00:00.000Z"),
      block("public-live", 0, "2026-07-13T02:00:00.000Z", "2026-07-13T02:15:00.000Z"),
      block("personal-ip", 0, "2026-07-13T02:15:00.000Z", "2026-07-13T02:35:00.000Z"),
    ],
  };

  const text = renderDailyExecutionBrief({
    date: DATE,
    schedule,
    tasks,
    timezone: TIMEZONE,
    feedbackNodes: [],
    doNotDo: [],
  });

  assert.equal(occurrences(text, "个人IP｜交付3条可剪辑原片并发布3条视频"), 1);
  assert.match(text, /10:00–10:15[\s\S]*10:15–10:35[\s\S]*18:30–19:00/);
});

test("excludes unknown and deferred tasks from the outcome count and labels deferred partial blocks", () => {
  const tasks = approvedTasks().slice(0, 3);
  const schedule = {
    date: DATE,
    deferred: ["personal-ip"],
    blocks: [
      block("public-live", 0, "2026-07-13T02:00:00.000Z", "2026-07-13T02:15:00.000Z"),
      block("personal-ip", 0, "2026-07-13T02:15:00.000Z", "2026-07-13T02:35:00.000Z"),
      block("jxos", 0, "2026-07-13T06:00:00.000Z", "2026-07-13T06:30:00.000Z"),
      block("unknown", 0, "2026-07-13T08:00:00.000Z", "2026-07-13T08:30:00.000Z"),
    ],
  };

  const text = renderDailyExecutionBrief({
    date: DATE,
    schedule,
    tasks,
    timezone: TIMEZONE,
  });

  assert.match(text, /【7月13日执行令｜今天只完成2个结果】/);
  assert.match(text, /10:15–10:35｜确定3个选题与开头钩子（部分进度，等待重排）/);
  assert.doesNotMatch(text, /unknown/);
});

test("uses checkpoint zero and falls back for null or out-of-range checkpoint indexes", () => {
  const task = {
    ...approvedTasks()[0],
    nextAction: "执行主任务下一步",
    doneDefinition: "达到主任务完成标准",
  };
  const schedule = {
    date: DATE,
    blocks: [
      block(task.id, 0, "2026-07-13T02:15:00.000Z", "2026-07-13T02:35:00.000Z"),
      block(task.id, null, "2026-07-13T03:00:00.000Z", "2026-07-13T03:15:00.000Z"),
      block(task.id, 99, "2026-07-13T03:15:00.000Z", "2026-07-13T03:30:00.000Z"),
    ],
  };

  const text = renderDailyExecutionBrief({ date: DATE, schedule, tasks: [task], timezone: TIMEZONE });

  assert.match(text, /10:15–10:35｜确定3个选题与开头钩子/);
  assert.equal(occurrences(text, `工作内容：${task.nextAction}`), 2);
  assert.equal(occurrences(text, `完成标准：${task.doneDefinition}`), 2);
});

test("does not duplicate a project prefix and renders midnight as 24:00 without mutating inputs", () => {
  const task = {
    ...approvedTasks()[1],
    checkpoints: [{ title: "记录实际订单、差距和明日唯一纠偏动作", doneDefinition: "完成直播结果复盘" }],
  };
  const input = {
    date: DATE,
    schedule: {
      date: DATE,
      blocks: [block(task.id, 0, "2026-07-13T15:30:00.000Z", "2026-07-13T16:00:00.000Z")],
    },
    tasks: [task],
    timezone: TIMEZONE,
    feedbackNodes: ["24:00"],
    doNotDo: ["不新增项目"],
  };
  const before = structuredClone(input);

  const text = renderDailyExecutionBrief(input);

  assert.equal(occurrences(text, "公域直播｜完成开播检查与30单结果复盘"), 1);
  assert.doesNotMatch(text, /公域直播｜公域直播｜/);
  assert.match(text, /23:30–24:00｜记录实际订单、差距和明日唯一纠偏动作/);
  assert.deepEqual(input, before);
});

test("parses the date heading directly instead of shifting it through UTC", () => {
  const text = renderDailyExecutionBrief({
    date: "2026-01-01",
    schedule: { date: "2026-01-01", blocks: [] },
    tasks: [],
    timezone: "America/Los_Angeles",
  });

  assert.match(text, /【1月1日执行令｜今天只完成0个结果】/);
});

test("renders an exact change-only checkpoint message", () => {
  const text = renderPlanDelta({
    node: "12:00",
    facts: ["个人IP拍摄提前40分钟完成"],
    changes: ["18:30发布验收提前到11:20–11:50"],
    currentAction: "把3条原片和标题交给剪辑人员",
    feedbackDeadline: "12:00",
  });

  assert.equal(text, [
    "【12:00计划调整】",
    "事实：个人IP拍摄提前40分钟完成",
    "调整：18:30发布验收提前到11:20–11:50",
    "现在只做：把3条原片和标题交给剪辑人员",
    "反馈截止：12:00",
  ].join("\n"));
});

test("returns no delta when there is no fact, change, or current action", () => {
  assert.equal(renderPlanDelta({
    node: "09:00",
    facts: [],
    changes: [],
    currentAction: "",
    feedbackDeadline: "12:00",
  }), "");
});

function approvedTasks() {
  return [
    {
      id: "personal-ip",
      project: "个人IP",
      title: "个人IP｜交付3条可剪辑原片并发布3条视频",
      nextAction: "确定3个选题与开头钩子",
      doneDefinition: "3条可剪辑原片已交付并发布3条视频",
      checkpoints: [
        checkpoint("确定3个选题与开头钩子", "3个选题和钩子已确认"),
        checkpoint("完成3条口播提纲", "3条口播提纲可直接拍摄"),
        checkpoint("拍摄3条可剪辑原片", "3条原片音画可用"),
        checkpoint("验收成片并发布3条视频", "3条视频已发布并保存链接"),
      ],
    },
    {
      id: "public-live",
      project: "公域直播",
      title: "公域直播｜完成开播检查与30单结果复盘",
      nextAction: "确认三主播排班、货盘和成交口径",
      doneDefinition: "完成开播检查并输出30单结果与纠偏动作",
      checkpoints: [
        checkpoint("确认三主播排班、货盘和成交口径", "主播均已进入执行，30单统计口径明确"),
        checkpoint("检查中场订单数据并只处理关键阻塞", "关键阻塞已处理或明确负责人"),
        checkpoint("记录实际订单、差距和明日唯一纠偏动作", "完成直播结果复盘"),
      ],
    },
    {
      id: "jxos",
      project: "极享OS",
      title: "验收线索模块并完成1名员工真实迁移",
      nextAction: "确认线索字段、权限与操作流程",
      doneDefinition: "1名员工完成真实线索操作",
      checkpoints: [
        checkpoint("确认线索字段、权限与操作流程", "字段、权限与流程可执行"),
        checkpoint("完成新增、分配、跟进和查询抽测", "主流程抽测全部通过"),
        checkpoint("让1名员工完成真实线索操作并记录问题", "1名员工完成真实线索操作"),
      ],
    },
    {
      id: "private-live",
      project: "私域直播",
      title: "确定本周首场方案并启动邀约",
      nextAction: "确定主题、目标人群和成交产品",
      doneDefinition: "首场方案明确且第一轮邀约已启动",
      checkpoints: [
        checkpoint("确定主题、目标人群和成交产品", "主题、人群和产品已确认"),
        checkpoint("确认海报文案、邀约名单和发送节奏", "文案、名单和节奏已确认"),
        checkpoint("明确直播分工并启动第一轮邀约", "第一轮邀约已启动"),
      ],
    },
  ];
}

function checkpoint(title, doneDefinition) {
  return { title, doneDefinition, completed: false };
}

function block(taskId, checkpointIndex, startsAt, endsAt) {
  return { taskId, checkpointIndex, startsAt, endsAt, status: "planned", reason: "test" };
}

function occurrences(text, needle) {
  return text.split(needle).length - 1;
}
