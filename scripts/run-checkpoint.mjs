#!/usr/bin/env node
import { loadConfig } from "../src/config.mjs";
import { createManagerRuntime } from "../src/manager-app.mjs";

let runtime;
try {
  const options = parseArgs(process.argv.slice(2));
  runtime = createManagerRuntime(loadConfig());
  const result = await runtime.checkpointRunner.run({
    ...(options.node ? { forcedNode: options.node } : {}),
    ...(options.now ? { now: options.now } : {}),
    dryRun: options.dryRun,
  });
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

function sanitizeError(error) {
  return String(error?.message || error).replace(/(app_secret|token|webhook|authorization)\s*[:=]\s*[^\s,]+/gi, "$1=[redacted]").slice(0, 500);
}
