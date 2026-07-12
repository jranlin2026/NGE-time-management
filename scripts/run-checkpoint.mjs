#!/usr/bin/env node
import { loadConfig } from "../src/config.mjs";
import { listConversationMessages } from "../src/lib/feishu-polling.mjs";
import { resolveCheckpointContext } from "../src/lib/checkpoint-schedule.mjs";
import { sanitizeError } from "../src/lib/sanitize-error.mjs";

let runtime;
try {
  const options = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  const result = options.dryRun
    ? await runDryDiagnostic(config, options)
    : await runCheckpoint(config, options);
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify({ status: "failed", error: sanitizeError(error) })}\n`);
  process.exitCode = 1;
} finally {
  await runtime?.close?.();
}

function parseArgs(args) {
  const options = { node: "", now: "", dryRun: false };
  for (const arg of args) {
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg.startsWith("--node=") && arg.length > 7) options.node = arg.slice(7);
    else if (arg.startsWith("--now=") && arg.length > 6) options.now = arg.slice(6);
    else throw new Error(`unsupported argument: ${arg}`);
  }
  return options;
}

async function runCheckpoint(config, options) {
  const { createManagerRuntime } = await import("../src/manager-app.mjs");
  runtime = createManagerRuntime(config);
  return runtime.checkpointRunner.run({
    ...(options.node ? { forcedNode: options.node } : {}),
    ...(options.now ? { now: options.now } : {}),
  });
}

async function runDryDiagnostic(config, options) {
  if (!config.feishuP2pChatId) throw new Error("dry-run requires FEISHU_P2P_CHAT_ID");
  const instant = new Date(options.now || new Date());
  if (Number.isNaN(instant.getTime())) throw new Error("valid checkpoint time is required");
  const messages = await listConversationMessages(config, {
    chatId: config.feishuP2pChatId,
    endTime: Math.floor(instant.getTime() / 1000),
  });
  const context = resolveCheckpointContext({ now: instant, timezone: config.timezone });
  return {
    status: "dry_run",
    workDate: context.workDate,
    nodes: options.node ? [options.node] : (context.currentNode ? [context.currentNode] : []),
    messagesRead: messages.length,
    messagesProcessed: 0,
    tasksCreated: 0,
    tasksUpdated: 0,
    repliesQueued: 0,
    reviewCreated: 0,
    errors: [],
  };
}
