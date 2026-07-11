import { dispatchToday } from "./dispatch.mjs";
import { sendFeishuText } from "./feishu.mjs";
import { ingestNaturalTask } from "./ingest.mjs";
import { readTasks, writeTasks } from "./task-store.mjs";
import { pickDailyTasks } from "./prioritizer.mjs";

const DISPATCH_COMMANDS = /^(今日任务|今天任务|生成计划|今天计划|dispatch)$/i;
const HELP_COMMANDS = /^(帮助|help|菜单)$/i;
const DONE_COMMAND = /^完成[:：]\s*(.+)$/;
const BLOCKED_COMMAND = /^卡住[:：]\s*(.+)$/;
const NEW_TASK_COMMAND = /^新增[:：]\s*(.+)$/;
const PLAN_QUERY =
  /((今天|今日|明天|明日|本周|这周|下周).*(任务|安排|计划).*(是什么|有哪些|什么|吗|？|\?)?|((任务|安排|计划).*(今天|今日|明天|明日|本周|这周|下周)))/;
const PROCRASTINATION_SIGNAL =
  /(不想|没状态|状态不好|拖延|逃避|害怕|压力|焦虑|不擅长|不知道怎么|不敢|想先|等会|改系统|整理知识库|看客户资料|看资料|聊别的项目|舒适区)/;
const TASK_SIGNAL =
  /(我要|需要|必须|得|完成|确认|准备|设计|写|做|发布|提交|跟进|开会|直播|课程|海报|招商|成交|迁移|出海|获客|IP|CRM|OS|今天|明天|本周|下周|这个月|\d+月\d+日|20\d{2}-\d{2}-\d{2})/;

export function extractMessageText(eventBody = {}) {
  if (eventBody.challenge) {
    return { kind: "challenge", challenge: eventBody.challenge };
  }

  const event = eventBody.event || eventBody;
  const message = event.message || event;
  const messageType = message.message_type || event.message_type || "text";
  if (["image", "file"].includes(messageType)) {
    const content = parseContent(message.content || event.content || "");
    const messageId = message.message_id || event.message_id || "";
    const chatId = message.chat_id || event.chat_id || "";
    const senderId = event.sender?.sender_id?.open_id || event.sender?.sender_id?.user_id || "";
    return {
      kind: "message",
      text: "",
      isEvidenceSubmission: true,
      evidence: [{
        type: messageType === "image" ? "feishu_image" : "file_reference",
        value: messageType === "image" ? (content.image_key || "") : (content.file_key || content.file_name || ""),
        messageId, chatId, senderId,
      }],
      messageId, chatId, senderId,
    };
  }
  if (messageType !== "text") {
    return {
      kind: "unsupported",
      messageType,
      messageId: message.message_id || event.message_id || "",
      chatId: message.chat_id || event.chat_id || "",
    };
  }

  const content = parseContent(message.content || event.content || "");
  const normalized = normalizeEvidenceMessage(content.text || content);
  return {
    kind: "message",
    text: normalizeInboundText(content.text || content),
    evidence: normalized.evidence,
    isEvidenceSubmission: normalized.isEvidenceSubmission,
    messageId: message.message_id || event.message_id || "",
    chatId: message.chat_id || event.chat_id || "",
    senderId:
      event.sender?.sender_id?.open_id ||
      event.sender?.sender_id?.user_id ||
      event.sender?.sender_id?.union_id ||
      "",
  };
}

export function normalizeEvidenceMessage(text = "") {
  const value = normalizeInboundText(text);
  const submission = value.match(/^提交结果[:：]\s*(.*?)\s*[｜|]\s*(.+)$/s);
  const evidence = [...value.matchAll(/https?:\/\/[^\s｜|]+/gi)]
    .map((match) => ({ type: "url", value: match[0].replace(/[，。！？、；：,.!?;:)]+$/, "") }));
  if (submission?.[2]?.trim()) evidence.unshift({ type: "text", value: submission[2].trim() });
  return { text: value, evidence, isEvidenceSubmission: Boolean(submission) };
}

export function selectReplyDestination(message = {}) {
  if (message.chatId) return { receiveId: message.chatId, receiveIdType: "chat_id" };
  return { receiveId: message.senderId || "", receiveIdType: "open_id" };
}

export function normalizeInboundText(text = "") {
  return String(text)
    .replace(/<at[^>]*>.*?<\/at>/g, "")
    .replace(/^@[^ ]+\s*/, "")
    .trim();
}

export function isDispatchCommand(text = "") {
  return DISPATCH_COMMANDS.test(String(text).trim());
}

export function isHelpCommand(text = "") {
  return HELP_COMMANDS.test(String(text).trim());
}

export function isPlanQuery(text = "") {
  return PLAN_QUERY.test(String(text).trim());
}

export async function handleFeishuInbound(config, input, options = {}) {
  const sendText = options.sendText || sendFeishuText;
  const ingestTask = options.ingestTask || ingestNaturalTask;
  const runDispatch = options.dispatchToday || dispatchToday;
  const readTaskList = options.readTasks || readTasks;
  const writeTaskList = options.writeTasks || writeTasks;
  const pickTasks = options.pickDailyTasks || pickDailyTasks;
  const extracted = typeof input === "string" ? { kind: "message", text: input } : extractMessageText(input);

  if (extracted.kind === "challenge") {
    return { action: "challenge", response: { challenge: extracted.challenge } };
  }

  if (extracted.kind === "unsupported") {
    await sendText(config, `我现在只处理文字消息。收到的是：${extracted.messageType}`);
    return { action: "unsupported", messageType: extracted.messageType };
  }

  const text = normalizeInboundText(extracted.text || "");
  if (!text) {
    return { action: "ignored", reason: "empty_text" };
  }

  if (isHelpCommand(text)) {
    const help = [
      "时间管理大师已在线。",
      "",
      "你在群里可以这样发：",
      "1. 今日任务：立刻重新下发今天最多 3 个关键任务",
      "2. 新增：7月8日前完成直播海报确认",
      "3. 完成：任务名",
      "4. 卡住：任务名 + 卡在哪里",
      "5. 我不想做直播演练：我会判断为拖延信号并给你 15 分钟动作",
      "",
      "原则：你只负责反馈，我负责判断优先级和拆下一步动作。",
    ].join("\n");
    const feishu = await sendText(config, help);
    return { action: "help", feishu };
  }

  if (isDispatchCommand(text)) {
    const result = await runDispatch(config);
    return { action: "dispatch", result };
  }

  if (isPlanQuery(text)) {
    const result = await replyPlanQuery(config, text, { readTaskList, pickTasks, sendText });
    return { action: "plan_query", ...result };
  }

  const done = text.match(DONE_COMMAND);
  if (done) {
    const update = await updateMatchingTask(config, done[1].trim(), {
      status: "done",
      blocker: "",
    }, { readTaskList, writeTaskList });
    const feishu = await sendText(
      config,
      [
        `收到完成反馈：${done[1].trim()}`,
        "",
        update.matched ? "我已把任务池里的对应任务标记为 done。" : "我没在任务池里找到完全匹配项，但完成反馈已收到。",
        "很好，先不要扩任务。继续看今天任务清单里的下一个关键任务。",
      ].join("\n"),
    );
    return { action: "done", title: done[1].trim(), update, feishu };
  }

  const blocked = text.match(BLOCKED_COMMAND);
  if (blocked) {
    const update = await updateMatchingTask(config, blocked[1].trim(), {
      status: "blocked",
      blocker: blocked[1].trim(),
      bumpProcrastination: true,
    }, { readTaskList, writeTaskList });
    const feishu = await sendText(
      config,
      [
        `收到卡点：${blocked[1].trim()}`,
        "",
        update.matched ? "我已把对应任务标记为 blocked，并增加一次拖延/卡点计数。" : "我没找到完全匹配的任务，但会按卡点处理。",
        "现在不要切换去改系统、整理知识库或看资料。",
        "降级执行：只做 15 分钟，把这个任务的最小下一步产出发到群里。",
      ].join("\n"),
    );
    return { action: "blocked", detail: blocked[1].trim(), update, feishu };
  }

  if (isProcrastinationSignal(text)) {
    const focus = await getCurrentFocus(config, { readTaskList, pickTasks });
    const feishu = await sendText(config, renderProcrastinationReply(text, focus));
    return { action: "coach_procrastination", focus, feishu };
  }

  if (!isTaskLike(text)) {
    const feishu = await sendText(
      config,
      [
        "收到，但我先不把这句话放进任务池，避免你用聊天替代行动。",
        "",
        "如果这是任务，请这样发：新增：任务内容 + 截止时间",
        "如果你在逃避，请直接发：卡住：任务名 + 卡在哪里",
        "如果要我重新管今天节奏，发：今日任务",
      ].join("\n"),
    );
    return { action: "conversation_guardrail", feishu };
  }

  const newTask = text.match(NEW_TASK_COMMAND);
  const taskText = newTask ? newTask[1].trim() : text;
  const task = await ingestTask(config.kbDir, taskText);
  const feishu = await sendText(
    config,
    [
      `已入池：${task.title}`,
      `项目：${task.project}`,
      `分类：${task.quadrant}`,
      "",
      "我会在下一次任务下发时判断它是否进入今天的 1-3 个关键任务。",
    ].join("\n"),
  );
  return { action: "ingest", task, feishu };
}

export function isProcrastinationSignal(text = "") {
  return PROCRASTINATION_SIGNAL.test(String(text));
}

export function isTaskLike(text = "") {
  return TASK_SIGNAL.test(String(text)) || NEW_TASK_COMMAND.test(String(text));
}

async function updateMatchingTask(config, query, patch, deps) {
  if (!config.kbDir) return { matched: false, reason: "missing_kb_dir" };
  const tasks = await deps.readTaskList(config.kbDir);
  const index = findTaskIndex(tasks, query);
  if (index === -1) return { matched: false };

  const current = tasks[index];
  tasks[index] = {
    ...current,
    ...patch,
    procrastinationCount: patch.bumpProcrastination
      ? Number(current.procrastinationCount || 0) + 1
      : Number(current.procrastinationCount || 0),
  };
  delete tasks[index].bumpProcrastination;
  await deps.writeTaskList(config.kbDir, tasks);
  return { matched: true, taskId: current.id, title: current.title };
}

async function getCurrentFocus(config, deps) {
  if (!config.kbDir) return null;
  const tasks = await deps.readTaskList(config.kbDir);
  const [first] = deps.pickTasks(tasks, new Date(), 1);
  return first?.task || null;
}

async function replyPlanQuery(config, text, deps) {
  const tasks = config.kbDir ? await deps.readTaskList(config.kbDir) : [];
  const picked = deps.pickTasks(tasks, new Date(), 3).map((item) => item.task);
  const label = /明天|明日/.test(text)
    ? "明天"
    : /本周|这周/.test(text)
      ? "本周"
      : /下周/.test(text)
        ? "下周"
        : "今天";
  const lines = [`${label}先不要重新开一堆任务，我按当前任务池给你看关键候选：`, ""];

  if (!picked.length) {
    lines.push("当前任务池没有可调度任务。请发：新增：任务内容 + 截止时间");
  } else {
    picked.forEach((task, index) => {
      lines.push(`${index + 1}. ${task.title}`);
      lines.push(`下一步：${task.nextAction}`);
      if (task.due) lines.push(`截止：${task.due}`);
      lines.push("");
    });
    lines.push("如果你要我正式下发今天任务，发：今日任务");
    if (label !== "今天") lines.push("未来计划我会作为候选，不会自动写成新任务。");
  }

  const feishu = await deps.sendText(config, lines.join("\n").trim());
  return { label, picked: picked.map((task) => task.title), feishu };
}

function renderProcrastinationReply(text, focus) {
  const lines = [
    "我判断这是一条拖延/逃避信号，不把它当普通聊天处理。",
    "",
    "现在规则：不改系统、不整理知识库、不看客户资料、不切换项目。",
  ];

  if (focus) {
    lines.push(
      "",
      `当前优先任务：${focus.title}`,
      `15 分钟动作：${focus.nextAction}`,
      "",
      "你现在只做这一小步。做完回：完成：任务名",
      "如果还是卡，回：卡住：任务名 + 具体卡点",
    );
  } else {
    lines.push(
      "",
      "当前任务池没有可聚焦任务。请发：今日任务，或发：新增：任务内容 + 截止时间",
    );
  }

  return lines.join("\n");
}

function findTaskIndex(tasks, query) {
  const value = normalizeMatchText(query);
  if (!value) return -1;
  return tasks.findIndex((task) => {
    const title = normalizeMatchText(task.title);
    return title.includes(value) || value.includes(title);
  });
}

function normalizeMatchText(value) {
  return String(value || "")
    .replace(/\s+/g, "")
    .replace(/[，。,.、:：]/g, "")
    .trim();
}

function parseContent(content) {
  if (!content) return {};
  if (typeof content === "object") return content;
  try {
    return JSON.parse(content);
  } catch {
    return { text: String(content) };
  }
}
