import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const LABEL = "com.nge.time-management-master";
const plistPath = path.join(os.homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
const domain = `gui/${process.getuid()}`;

try {
  await execFileAsync("launchctl", ["bootout", domain, plistPath]);
} catch {
  // Already stopped.
}
await fs.rm(plistPath, { force: true });
console.log(`Uninstalled ${LABEL}`);
