import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { loadConfig } from "../src/config.mjs";

const execFileAsync = promisify(execFile);
const LABEL = "com.nge.time-management-master";

export function renderLaunchAgentPlist({ nodePath, scriptPath, workingDirectory, dataDir }) {
  const logsDir = path.join(dataDir, "logs");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(LABEL)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(nodePath)}</string>
    <string>${escapeXml(scriptPath)}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${escapeXml(workingDirectory)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>${escapeXml(path.join(logsDir, "manager.stdout.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(path.join(logsDir, "manager.stderr.log"))}</string>
</dict>
</plist>
`;
}

export async function installLaunchAgent({ projectDir = path.resolve("."), nodePath = process.execPath } = {}) {
  const config = loadConfig();
  const agentsDir = path.join(os.homedir(), "Library", "LaunchAgents");
  const plistPath = path.join(agentsDir, `${LABEL}.plist`);
  const scriptPath = path.join(projectDir, "scripts", "run-manager.mjs");
  await fs.mkdir(agentsDir, { recursive: true });
  await fs.mkdir(path.join(config.dataDir, "logs"), { recursive: true });
  await fs.writeFile(
    plistPath,
    renderLaunchAgentPlist({ nodePath, scriptPath, workingDirectory: projectDir, dataDir: config.dataDir }),
    "utf8",
  );
  const domain = `gui/${process.getuid()}`;
  try {
    await execFileAsync("launchctl", ["bootout", domain, plistPath]);
  } catch {
    // The service may not be loaded yet.
  }
  await execFileAsync("launchctl", ["bootstrap", domain, plistPath]);
  await execFileAsync("launchctl", ["kickstart", "-k", `${domain}/${LABEL}`]);
  return { label: LABEL, plistPath };
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  const result = await installLaunchAgent();
  console.log(`Installed ${result.label}: ${result.plistPath}`);
}
