const APPROVED_WORK_DATE = "2026-07-13";

const APPROVED_TASKS = [
  {
    id: "wk20260713-personal-ip",
    title: "个人IP｜交付3条可剪辑原片并发布3条视频",
    project: "个人IP",
    projectId: "personal-ip",
    nextAction: "确定3个选题与开头钩子",
    doneDefinition: "3条原片音画可用并交给剪辑；3条成片完成标题、封面和文案检查后发布；保存发布链接或截图。",
    estimateMinutes: 135,
    checkpoints: [
      checkpoint("确定3个选题与开头钩子", 20, "02:15", "02:35", "3个选题和钩子已确认"),
      checkpoint("完成3条口播提纲", 40, "02:35", "03:15", "3条口播提纲可直接拍摄"),
      checkpoint("拍摄3条可剪辑原片", 45, "03:15", "04:00", "3条原片音画可用"),
      checkpoint("验收成片并发布3条视频", 30, "10:30", "11:00", "3条视频已发布并保存链接"),
    ],
  },
  {
    id: "wk20260713-jxos-leads",
    title: "极享OS｜验收线索模块并完成1名员工真实迁移",
    project: "极享OS",
    projectId: "jixiang-os",
    nextAction: "确认线索字段、权限与操作流程",
    doneDefinition: "员工能独立完成主流程；阻断问题为零；非阻断问题进入问题清单并明确负责人和时间。",
    estimateMinutes: 120,
    checkpoints: [
      checkpoint("确认线索字段、权限与操作流程", 30, "06:00", "06:30", "字段、权限与流程可执行"),
      checkpoint("完成新增、分配、跟进和查询抽测", 45, "06:30", "07:15", "主流程抽测全部通过"),
      checkpoint("让1名员工完成真实线索操作并记录问题", 45, "07:15", "08:00", "1名员工完成真实线索操作"),
    ],
  },
  {
    id: "wk20260713-public-live",
    title: "公域直播｜完成开播检查与30单结果复盘",
    project: "公域直播",
    projectId: "public-live",
    nextAction: "确认三主播排班、货盘和成交口径",
    doneDefinition: "完成开播检查并输出30单结果与纠偏动作",
    estimateMinutes: 60,
    checkpoints: [
      checkpoint("确认三主播排班、货盘和成交口径", 15, "02:00", "02:15", "主播均已进入执行，30单统计口径明确"),
      checkpoint("检查中场订单数据并只处理关键阻塞", 15, "10:00", "10:15", "关键阻塞已处理或明确负责人"),
      checkpoint("记录实际订单、差距和明日唯一纠偏动作", 30, "15:30", "16:00", "完成直播结果复盘"),
    ],
  },
  {
    id: "wk20260713-private-live",
    title: "私域直播｜确定本周首场方案并启动邀约",
    project: "私域直播",
    projectId: "private-live",
    nextAction: "确定主题、目标人群和成交产品",
    doneDefinition: "主题、邀约对象、成交产品、文案、发送节奏和负责人全部明确，第一轮邀约已启动。",
    estimateMinutes: 60,
    checkpoints: [
      checkpoint("确定主题、目标人群和成交产品", 20, "12:00", "12:20", "主题、人群和产品已确认"),
      checkpoint("确认海报文案、邀约名单和发送节奏", 20, "12:20", "12:40", "文案、名单和节奏已确认"),
      checkpoint("明确直播分工并启动第一轮邀约", 20, "12:40", "13:00", "第一轮邀约已启动"),
    ],
  },
];

const APPROVED_IDS = new Set(APPROVED_TASKS.map((task) => task.id));

export function seedPersonalWeek({ tasks, ops, workDate }) {
  if (workDate !== APPROVED_WORK_DATE) {
    throw new Error(`approved personal week seed requires workDate ${APPROVED_WORK_DATE}`);
  }

  for (const approved of APPROVED_TASKS) {
    const existing = tasks.findById(approved.id);
    const approvedCheckpoints = approved.checkpoints.map((item) => ({
      ...item,
      completed: existing?.checkpoints.some((current) =>
        current.title === item.title && current.completed,
      ) || false,
    }));
    const fields = {
      title: approved.title,
      project: approved.project,
      dueAt: workDate,
      nextAction: approved.nextAction,
      doneDefinition: approved.doneDefinition,
      estimateMinutes: approved.estimateMinutes,
      checkpoints: approvedCheckpoints,
      projectId: approved.projectId,
    };

    const unchanged = existing && Object.entries(fields).every(([key, value]) =>
      key === "checkpoints"
        ? JSON.stringify(existing.checkpoints) === JSON.stringify(value)
        : existing[key] === value,
    );
    if (existing && !unchanged) tasks.update(approved.id, fields);
    else if (!existing) tasks.create({
      id: approved.id,
      rawInput: approved.title,
      status: "ready",
      analysisStatus: "approved-week-seed",
      ...fields,
    });
  }

  const replacementTaskIds = APPROVED_TASKS.map((task) => task.id);
  for (const task of tasks.listActive()) {
    if (task.dueAt !== workDate || APPROVED_IDS.has(task.id)) continue;
    ops.appendEvent({
      taskId: task.id,
      kind: "task_superseded_by_clear_plan",
      payload: { workDate, replacementTaskIds },
      idempotencyKey: `approved-personal-week:${workDate}:supersede:${task.id}`,
    });
    tasks.update(task.id, { status: "cancelled" });
  }

  return { workDate, taskIds: replacementTaskIds };
}

function checkpoint(title, minutes, startsAt, endsAt, doneDefinition) {
  return {
    title,
    minutes,
    startsAt: `${APPROVED_WORK_DATE}T${startsAt}:00.000Z`,
    endsAt: `${APPROVED_WORK_DATE}T${endsAt}:00.000Z`,
    doneDefinition,
  };
}
