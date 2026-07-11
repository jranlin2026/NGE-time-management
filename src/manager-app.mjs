import fs from "node:fs";
import { deliverFeishuOutbound } from "./lib/feishu-delivery.mjs";
import { openDatabase, withTransaction } from "./db/database.mjs";
import { backupDatabase } from "./db/backup.mjs";
import { createTaskRepository } from "./db/task-repository.mjs";
import { createOperationsRepository } from "./db/operations-repository.mjs";
import { createProjectOperationsRepository } from "./db/project-operations-repository.mjs";
import { createCodexAnalyzer } from "./lib/codex-analyzer.mjs";
import { createProjectMarkdownRepository } from "./lib/project-markdown-repository.mjs";
import { createWeeklyPlanRepository } from "./lib/weekly-plan-repository.mjs";
import { createWeeklyPlanningService } from "./lib/weekly-planning-service.mjs";
import { createManagerService } from "./lib/manager-service.mjs";
import { createReminderEngine } from "./lib/reminder-engine.mjs";
import { createOutboxWorker } from "./lib/outbox-worker.mjs";
import { recoverManagerState } from "./lib/recovery.mjs";
import { buildDailyReview, renderDailyReview } from "./lib/daily-review.mjs";
import { exportDay } from "./lib/markdown-export.mjs";
import {
  renderCurrentTaskCard,
  renderDailyPlanCard,
  renderInterventionCard,
  renderConfirmedProjectSetupCard,
  renderConfirmedWeeklyPlanCard,
  renderProjectSetupCard,
  renderReviewCard,
  renderWeeklyPlanCard,
} from "./lib/feishu-cards.mjs";
import {
  extractCardAction,
  normalizeManagerAction,
  syncFeishuTask,
} from "./lib/feishu-messages.mjs";
import {
  extractMessageText,
  isDispatchCommand,
  isHelpCommand,
  isPlanQuery,
  selectReplyDestination,
} from "./lib/feishu-events.mjs";
import { zonedDateTimeToUtc } from "./lib/schedule-engine.mjs";

export function createManagerApp(config, deps = {}) {
  const db = deps.db || openDatabase(config.dbPath);
  const ownsDatabase = !deps.db;
  const clock = deps.clock || { now: () => new Date() };
  const intervalFn = deps.setInterval || globalThis.setInterval;
  const clearIntervalFn = deps.clearInterval || globalThis.clearInterval;
  const tasks = createTaskRepository(db);
  const ops = createOperationsRepository(db);
  const projectOps = createProjectOperationsRepository(db);
  const projectRepo = deps.projectRepo || createProjectMarkdownRepository({ kbDir: config.kbDir });
  const weeklyPlanRepo = deps.weeklyPlanRepo || createWeeklyPlanRepository({ kbDir: config.kbDir });
  if (!config.feishuReceiveId) {
    const destination = ops.getSetting("feishu_receive_destination");
    config.feishuReceiveId = destination?.receiveId || ops.getSetting("feishu_receive_id") || "";
    config.feishuReceiveIdType = destination?.receiveIdType || config.feishuReceiveIdType;
  }
  const settings = loadManagerSettings(config, ops);
  const analyzer = deps.analyzer || createCodexAnalyzer(config);
  const weeklyPlanning = deps.weeklyPlanning || createWeeklyPlanningService({
    projectRepo, weeklyPlanRepo, projectOps, ops, analyzer, transaction: (fn) => withTransaction(db, fn),
  });
  let manager;

  async function runDailyReview(date) {
    const summary = buildDailyReview({
      date,
      tasks: tasks.listAll(),
      schedule: { blocks: ops.currentSchedule(date) },
      events: ops.listEvents({ date }),
    });
    const renderedText = renderDailyReview(summary);
    ops.saveReview({ date, summary, renderedText });
    await exportDay({
      exportDir: config.markdownExportDir,
      kbDir: config.kbDir,
      date,
      schedule: {
        blocks: ops.currentSchedule(date).map((block) => ({
          ...block,
          title: tasks.findById(block.taskId)?.title || block.taskId,
        })),
      },
      review: summary,
    });
    ops.appendEvent({
      kind: "daily_review_created",
      payload: summary,
      idempotencyKey: `daily-review:${date}`,
    });
    ops.enqueueOutbox({
      kind: "review_card",
      payload: { summary },
      idempotencyKey: `review-card:${date}`,
    });
    return summary;
  }

  const reminderEngine = createReminderEngine({
    tasks,
    ops,
    analyzer,
    replan: (input) => manager.replanDay({ reason: input.reason, now: input.now }),
    clock,
    handlers: {
      daily_plan: (reminder) => {
        seedFixedReminders({ now: new Date(reminder.dueAt), config, settings, ops });
        return manager.dispatchDay({
          date: localDate(new Date(reminder.dueAt), settings.timezone),
          now: reminder.dueAt,
        });
      },
      midday: (reminder) => manager.runMiddayCheck({
        date: localDate(new Date(reminder.dueAt), settings.timezone),
        now: reminder.dueAt,
      }),
      day_close: (reminder) => manager.runDayClose({
        date: localDate(new Date(reminder.dueAt), settings.timezone),
        now: reminder.dueAt,
      }),
      daily_review: (reminder) => runDailyReview(
        localDate(new Date(reminder.dueAt), settings.timezone),
      ),
      backup: async (reminder) => {
        const file = await backupDatabase({ db, backupDir: config.backupDir, now: new Date(reminder.dueAt) });
        ops.appendEvent({
          kind: "database_backed_up",
          payload: { fileName: file.split("/").at(-1) },
          idempotencyKey: `backup:${reminder.dueAt}`,
        });
      },
      defer_resume: (reminder) => manager.resumeDeferredTask(reminder.taskId),
    },
  });

  manager = createManagerService({
    db,
    transaction: (fn) => withTransaction(db, fn),
    tasks,
    ops,
    projectOps,
    analyzer,
    reminderEngine,
    clock,
    settings,
  });

  const outboxWorker = createOutboxWorker({
    ops,
    clock,
    send: deps.sendOutbox || ((row) => deliverOutbox(config, row, { tasks, ops, settings })),
  });

  let connector = null;
  const timers = [];
  let started = false;

  async function start() {
    if (started) return;
    const setup = await projectRepo.ensureDraftTemplates(PROJECT_SPECS);
    const draftProjects = setup.projects.filter((project) => project.status === "draft");
    if (draftProjects.length) {
      ops.enqueueOutbox({
        kind: "project_setup_card",
        payload: { projects: draftProjects },
        idempotencyKey: "project-setup-card:initial",
      });
    }
    await importLegacyTasksOnce(config, tasks, ops);
    seedFixedReminders({ now: clock.now(), config, settings, ops });
    const today = localDate(clock.now(), settings.timezone);
    await recoverManagerState({
      now: clock.now().toISOString(),
      date: today,
      tasks,
      ops,
      replan: (input) => manager.replanDay({ reason: input.reason, date: input.date, now: input.now }),
    });
    const connect = deps.connectFeishu || connectFeishu;
    connector = await connect(config, { manager, tasks, ops, projectRepo, weeklyPlanning });
    timers.push(intervalFn(() => runSafely("reminder poll", () => reminderEngine.processDue()), 30_000));
    timers.push(intervalFn(() => runSafely("outbox poll", () => outboxWorker.flush()), 10_000));
    started = true;
  }

  async function stop() {
    for (const timer of timers.splice(0)) clearIntervalFn(timer);
    await connector?.stop?.();
    connector = null;
    if (ownsDatabase) db.close();
    started = false;
  }

  return {
    start,
    stop,
    generateWeeklyPlan: (input) => weeklyPlanning.generateDraft(input),
    state: { db, tasks, ops, projectOps, projectRepo, weeklyPlanRepo, weeklyPlanning, manager, reminderEngine, outboxWorker, settings },
  };
}

export async function connectFeishu(config, { manager, tasks, ops, projectRepo, weeklyPlanning }) {
  if (!config.feishuAppId || !config.feishuAppSecret) {
    throw new Error("Missing FEISHU_APP_ID or FEISHU_APP_SECRET");
  }
  const lark = await import("@larksuiteoapi/node-sdk");
  const dispatcher = new lark.EventDispatcher({
    verificationToken: config.feishuVerificationToken || undefined,
    encryptKey: config.feishuEncryptKey || undefined,
  });
  const handleCardAction = createCardActionHandler({ manager, projectRepo, weeklyPlanning, ops });
  const handleMessage = createMessageHandler({ config, manager, ops, weeklyPlanning });
  dispatcher.register({
    "im.message.receive_v1": async (data) => {
      const message = extractMessageText(data);
      return handleMessage(message);
    },
    "card.action.trigger": async (data) => {
      const extracted = extractCardAction(data);
      const action = extracted ? normalizeManagerAction(extracted) : null;
      if (["start", "confirm_project_setup", "confirm_weekly_plan", "adjust_weekly_plan"].includes(action?.action)) {
        try {
          return await handleCardAction(action);
        } catch (error) {
          console.error(`card action failed: ${error.message}`);
          return { toast: { type: "error", content: `开始失败：${error.message}` } };
        }
      }
      if (action) {
        void manager.handleAction(action).catch((error) => {
          console.error(`card action failed: ${error.message}`);
        });
      }
      return { toast: { type: "success", content: "已收到，计划会自动更新。" } };
    },
  });
  const wsClient = new lark.WSClient({
    appId: config.feishuAppId,
    appSecret: config.feishuAppSecret,
    autoReconnect: true,
    loggerLevel: lark.LoggerLevel.info,
    onReady: () => console.log("Feishu WebSocket connected. Time manager is active."),
    onReconnecting: () => console.log("Feishu WebSocket reconnecting..."),
    onReconnected: () => console.log("Feishu WebSocket reconnected."),
    onError: (error) => console.error(`Feishu WebSocket error: ${error.message}`),
  });
  await wsClient.start({ eventDispatcher: dispatcher });
  return {
    async stop() {
      await wsClient.stop?.();
      await wsClient.close?.();
    },
  };
}

export function createMessageHandler({ config, manager, ops, weeklyPlanning }) {
  return async function handleMessage(message) {
    if (message.kind !== "message" || !message.text) return;
    if ((!config.feishuReceiveId || (message.chatId && config.feishuReceiveIdType !== "chat_id")) && (message.chatId || message.senderId)) {
      const destination = selectReplyDestination(message);
      config.feishuReceiveId = destination.receiveId;
      config.feishuReceiveIdType = destination.receiveIdType;
      ops.setSetting("feishu_receive_id", destination.receiveId);
      ops.setSetting("feishu_receive_destination", destination);
    }
    const action = normalizeManagerAction(message.text);
    if (action?.action === "adjust_weekly_plan") {
      const pending = ops.getSetting("pending_weekly_adjustment");
      if (!pending) throw new Error("no weekly plan is awaiting adjustment");
      await weeklyPlanning.requestAdjustment({
        ...pending, reason: action.detail, eventId: `message:${message.messageId}`,
      });
      ops.setSetting("pending_weekly_adjustment", null);
      return;
    }
    if (action) {
      await manager.handleAction({ ...action, idempotencyKey: `message:${message.messageId}` });
      return;
    }
    if (isDispatchCommand(message.text) || isPlanQuery(message.text)) return manager.dispatchDay();
    if (isHelpCommand(message.text)) {
      ops.enqueueOutbox({ kind: "help_message", payload: {}, idempotencyKey: `help:${message.messageId}` });
      return;
    }
    return manager.ingest({ messageId: message.messageId, text: message.text, chatId: message.chatId, senderId: message.senderId });
  };
}

export function createCardActionHandler({ manager, projectRepo, weeklyPlanning, ops }) {
  return async function handleCardAction(action) {
    if (action.action === "confirm_weekly_plan") {
      const plan = await weeklyPlanning.confirm({
        weekId: String(action.weekId).trim(),
        version: Number(action.version),
        eventId: action.idempotencyKey,
      });
      return { toast: { type: "success", content: "周计划已确认" }, card: renderConfirmedWeeklyPlanCard(plan) };
    }
    if (action.action === "confirm_project_setup") {
      const confirmed = [];
      for (const identity of action.projects || []) {
        const current = await projectRepo.readProject?.(identity.projectId);
        if (current?.status === "active") confirmed.push(current);
        else confirmed.push(await projectRepo.confirmDraft(identity.projectId, identity.contentHash));
      }
      return { toast: { type: "success", content: "项目初始设置已确认" }, card: renderConfirmedProjectSetupCard(confirmed) };
    }
    if (action.action === "adjust_weekly_plan") {
      ops?.setSetting("pending_weekly_adjustment", { weekId: String(action.weekId).trim(), version: Number(action.version) });
      return { toast: { type: "info", content: "请回复：调整周计划｜具体原因" } };
    }
    const result = await manager.handleAction(action);
    return renderCardActionResponse(action, result);
  };
}

export function renderCardActionResponse(action, result) {
  if (action?.action === "start" && result?.task) {
    const alreadyStarted = ["already_started", "duplicate"].includes(result.action);
    return {
      toast: {
        type: "success",
        content: alreadyStarted ? "任务已经在进行中。" : "已开始，专注完成当前任务。",
      },
      card: renderCurrentTaskCard({
        task: { ...result.task, status: "doing" },
        startsAt: "已开始",
        endsAt: "完成为止",
      }),
    };
  }
  return { toast: { type: "success", content: "已收到，计划会自动更新。" } };
}

export function seedFixedReminders({ now, config, settings, ops }) {
  const today = localDate(now, settings.timezone);
  for (let offset = 0; offset < 7; offset += 1) {
    const date = addDays(today, offset);
    const planAt = zonedDateTimeToUtc(date, config.schedule.plan, settings.timezone);
    const middayAt = zonedDateTimeToUtc(date, config.schedule.midday, settings.timezone);
    const closeAt = zonedDateTimeToUtc(date, config.schedule.dayClose, settings.timezone);
    const reviewAt = zonedDateTimeToUtc(date, config.schedule.eveningEnd, settings.timezone);
    const definitions = [
      ["daily_plan", planAt, middayAt],
      ["midday", middayAt, zonedDateTimeToUtc(date, config.schedule.afternoon, settings.timezone)],
      ["day_close", closeAt, zonedDateTimeToUtc(date, config.schedule.eveningStart, settings.timezone)],
      ["daily_review", reviewAt, new Date(reviewAt.getTime() + 2 * 60 * 60_000)],
      ["backup", new Date(reviewAt.getTime() + 10 * 60_000), new Date(reviewAt.getTime() + 4 * 60 * 60_000)],
    ];
    for (const [kind, dueAt, expiresAt] of definitions) {
      ops.enqueueReminder({
        kind,
        dueAt: dueAt.toISOString(),
        expiresAt: expiresAt.toISOString(),
        idempotencyKey: `fixed:${kind}:${date}`,
      });
    }
  }
}

async function deliverOutbox(config, row, { tasks, ops, settings }) {
  if (row.kind === "feishu_task_create" || row.kind === "feishu_task_update") {
    const result = await syncFeishuTask(config, row.payload);
    if (row.kind === "feishu_task_create" && result.externalId) {
      ops.setSetting(`feishu_task_guid:${row.payload.localTaskId}`, result.externalId);
    }
    return result;
  }

  const effectiveConfig = {
    ...config,
    feishuReceiveId: config.feishuReceiveId || ops.getSetting("feishu_receive_id") || "",
  };
  const card = cardForOutbox(row, { tasks, settings });
  const text = textForOutbox(row);
  if (card) return deliverFeishuOutbound(effectiveConfig, { kind: "card", card, text });
  return deliverFeishuOutbound(effectiveConfig, { kind: "text", text });
}

function cardForOutbox(row, { tasks, settings }) {
  if (row.payload.card) return row.payload.card;
  if (row.kind === "weekly_plan_card") return renderWeeklyPlanCard(row.payload);
  if (row.kind === "project_setup_card") return renderProjectSetupCard(row.payload);
  if (row.kind === "current_task_card") {
    return renderCurrentTaskCard({ task: row.payload.task, startsAt: "按计划", endsAt: "完成为止" });
  }
  if (row.kind === "intervention_card") return renderInterventionCard(row.payload);
  if (row.kind === "review_card") return renderReviewCard(row.payload.summary);
  if (row.kind === "recovery_plan_card") {
    const blocks = (row.payload.blocks || []).map((block) => {
      const task = tasks.findById(block.taskId) || { id: block.taskId, title: "待恢复任务" };
      return {
        ...task,
        startsAt: localTime(block.startsAt, settings.timezone),
        endsAt: localTime(block.endsAt, settings.timezone),
        reason: row.payload.reason,
      };
    });
    return renderDailyPlanCard({ date: row.payload.date, blocks });
  }
  return null;
}

const PROJECT_SPECS = [
  {
    projectId: "personal-ip", name: "个人IP", priority: 1,
    milestoneId: "content-validation", milestoneName: "内容验证",
    deliverableId: "first-content-result", deliverableName: "完成首个可验收内容成果",
    goal: "稳定产出并验证个人IP内容。",
  },
  {
    projectId: "jixiang-os", name: "极享OS", priority: 2,
    milestoneId: "system-validation", milestoneName: "系统验证",
    deliverableId: "first-system-result", deliverableName: "完成首个可验收系统成果",
    goal: "持续完善并验证极享OS。",
  },
];

function textForOutbox(row) {
  if (row.kind === "task_ack") return `已入池：${row.payload.title}\n${row.payload.text}`;
  if (row.kind === "status_message") return row.payload.text;
  if (row.kind === "no_response_message") return `${row.payload.mentionOwner ? "@你，" : ""}还没有收到反馈：${row.payload.title}\n现在只决定一件事：开始、完成，还是卡住？`;
  if (row.kind === "current_task_conflict") return `当前正在执行：${row.payload.currentTask.title}\n先完成、卡住或推迟当前任务，再开始：${row.payload.requestedTask.title}`;
  if (row.kind === "disambiguation_card") return [
    "找到多个相似任务，请回复完整任务名：",
    ...row.payload.tasks.map((task, index) => `${index + 1}. ${task.title}`),
  ].join("\n");
  if (row.kind === "help_message") return [
    "时间管理负责人已在线。",
    "新增任务：直接说要做什么。",
    "查看计划：今日任务。",
    "反馈：开始：任务名 / 完成：任务名 / 卡住：任务名 + 原因 / 推迟30分钟：任务名。",
  ].join("\n");
  return "时间管理计划已更新。";
}

async function importLegacyTasksOnce(config, tasks, ops) {
  if (ops.getSetting("legacy_markdown_imported")) return;
  if (!config.kbDir || !fs.existsSync(config.kbDir)) return;
  const imported = await tasks.importMarkdown(config.kbDir);
  ops.setSetting("legacy_markdown_imported", { imported, at: new Date().toISOString() });
}

function loadManagerSettings(config, ops) {
  const existing = ops.getSetting("manager_settings");
  const coachDefaults = {
    timezone: config.timezone || "Asia/Shanghai",
    managerUserId: config.managerUserId || "",
    windows: [
      [config.schedule.firstTask, "12:00"],
      [config.schedule.afternoon, config.schedule.eveningEnd],
    ],
    maxCriticalTasks: 5,
    capacityRatio: 0.7,
    projectMinimumMinutes: 60,
    noResponseMinutes: config.schedule.noResponseMinutes || 15,
    projectMinimums: { "个人IP": 2, "极享OS": 2 },
    projectWindows: {
      "个人IP": [["10:00", "12:00"], ["14:00", "16:00"]],
      "极享OS": [["10:00", "12:00"], ["14:00", "24:00"]],
    },
    projectBoosts: [
      { project: "个人IP", points: 100, startsOn: "2026-07-10", endsOn: "2026-07-15" },
    ],
    coachRulesVersion: 2,
  };
  const settings = existing?.coachRulesVersion >= 2
    ? { ...coachDefaults, ...existing, managerUserId: config.managerUserId || existing.managerUserId || "" }
    : { ...existing, ...coachDefaults, managerUserId: config.managerUserId || existing?.managerUserId || "" };
  ops.setSetting("manager_settings", settings);
  return settings;
}

function addDays(date, count) {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + count);
  return value.toISOString().slice(0, 10);
}

function localDate(date, timezone) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function localTime(value, timezone) {
  if (!value) return "未设置";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(value));
}

async function runSafely(label, fn) {
  try {
    await fn();
  } catch (error) {
    console.error(`${label} failed: ${error.message}`);
  }
}
