#!/usr/bin/env node
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { loadConfig } from "../src/config.mjs";
import { createAutomationRepository } from "../src/db/automation-repository.mjs";
import { openDatabase } from "../src/db/database.mjs";
import { deleteTask, getTask, listSubtasks, listTasklistTasks } from "../src/lib/feishu-tasks.mjs";
import {
  applyPersonalPlanCutover,
  parsePersonalPlanCutoverArgs,
  preparePersonalPlanCutover,
} from "../src/lib/personal-plan-cutover.mjs";

let db;
try {
  const options = parsePersonalPlanCutoverArgs(process.argv.slice(2));
  const config = loadConfig();
  const manifestDir = path.join(config.dataDir, "cutover");
  assertSchemaSix(config.dbPath);
  const api = { deleteTask, getTask, listSubtasks, listTasklistTasks };
  if (options.command === "apply") {
    db = openDatabase(config.dbPath);
    const repo = createAutomationRepository(db);
    print(await applyPersonalPlanCutover({
      manifestPath: options.manifestPath,
      manifestDir,
      repo,
      api,
      config,
    }));
  } else {
    db = new DatabaseSync(config.dbPath, { readOnly: true });
    db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=5000;");
    const repo = createAutomationRepository(db);
    print(await preparePersonalPlanCutover({
      ...options,
      manifestDir,
      repo,
      api,
      config,
    }));
  }
} catch {
  print({ status: "failed" });
  process.exitCode = 1;
} finally {
  db?.close();
}

function assertSchemaSix(dbPath) {
  const readonly = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const row = readonly.prepare("SELECT max(version) AS version FROM schema_migrations").get();
    if (Number(row?.version) !== 6) throw new Error("cutover requires schema version 6");
  } finally {
    readonly.close();
  }
}

function print(summary) {
  process.stdout.write(`${JSON.stringify(summary)}\n`);
}
