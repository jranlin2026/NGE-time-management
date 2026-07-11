export function renderDailyPlanCard({ date, blocks }) {
  const elements = [markdown(`**${date} 今日只锁定 ${new Set(blocks.map((block) => block.id || block.taskId)).size} 件事**`)];
  blocks.forEach((block, index) => {
    elements.push(markdown([
      `**${index + 1}. ${block.title}**`,
      `${block.startsAt}–${block.endsAt}`,
      `下一步：${block.nextAction || "按当前下一步执行"}`,
      `完成标准：${block.doneDefinition || "提交明确产出并反馈完成"}`,
      `排序原因：${block.reason || "当前综合优先级最高"}`,
    ].join("\n")));
    elements.push({ tag: "hr" });
  });
  elements.push(button("确认今日计划", "confirm_plan", "", "primary"));
  return card("今日作战卡", "blue", elements);
}

export function renderCurrentTaskCard({ task, startsAt, endsAt }) {
  const checkpoints = task.checkpoints || [];
  const isDoing = task.status === "doing";
  const actions = [
    ...(!isDoing ? [button("▶ 开始", "start", task.id, "primary")] : []),
    button("✓ 完成", "complete", task.id, "primary"),
    button("! 卡住", "block", task.id, "danger"),
    button("＋ 推迟 30 分钟", "defer_30", task.id, "default"),
  ];
  return card(isDoing ? "进行中：现在只做这一件" : "现在只做这一件", "purple", [
    markdown([
      `**${task.title}**`,
      ...(isDoing ? ["状态：**进行中**"] : []),
      `时间：${startsAt}–${endsAt}`,
      `第一步：${task.nextAction}`,
      `完成标准：${task.doneDefinition}`,
    ].join("\n")),
    ...checkpoints.map((checkpoint, index) => checkpoint.completed
      ? markdown(`✓ ${checkpoint.title}`)
      : button(`○ ${checkpoint.title}`, "complete_checkpoint", task.id, "default", { checkpointIndex: index })),
    buttonRow(actions),
  ]);
}

export function renderInterventionCard({ task, minimumAction, minutes = 15, coachText = "" }) {
  return card("任务已缩小", "red", [
    markdown([
      `已记录一次拖延：**${task.title}**`,
      `现在只做 ${minutes} 分钟：**${minimumAction}**`,
      coachText,
      "不重做计划，不切换项目，完成后直接反馈。",
    ].join("\n")),
    button(`立即开始 ${minutes} 分钟`, "start", task.id, "primary"),
  ]);
}

export function renderReviewCard(summary) {
  const candidates = summary.tomorrowCandidates?.length
    ? summary.tomorrowCandidates.map((title) => `- ${title}`).join("\n")
    : "- 暂无未完成候选";
  return card(`${summary.date} 晚间复盘`, "green", [
    markdown([
      `**今日完成度 ${summary.completionRate}%**`,
      `完成 ${summary.criticalCompleted}/${summary.criticalPlanned} 个关键任务`,
      `拖延 ${summary.procrastinationCount || 0} 次`,
      "**明日候选**",
      candidates,
    ].join("\n")),
    button("确认复盘", "confirm_review", "", "primary"),
    button("补充说明", "add_review_note", "", "default"),
  ]);
}

function card(title, template, elements) {
  return {
    schema: "2.0",
    config: { wide_screen_mode: true },
    header: {
      title: { tag: "plain_text", content: title },
      template,
    },
    body: { elements },
  };
}

function markdown(content) {
  return { tag: "markdown", content };
}

function buttonRow(buttons) {
  return {
    tag: "column_set",
    flex_mode: "flow",
    horizontal_spacing: "small",
    horizontal_align: "left",
    columns: buttons.map((item) => ({
      tag: "column",
      width: "weighted",
      weight: 1,
      vertical_align: "center",
      elements: [item],
    })),
  };
}

function button(content, action, taskId, type, extraValue = {}) {
  return {
    tag: "button",
    text: { tag: "plain_text", content },
    type,
    behaviors: [
      {
        type: "callback",
        value: { action, taskId, ...extraValue },
      },
    ],
  };
}
