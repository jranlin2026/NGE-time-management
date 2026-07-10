import assert from "node:assert/strict";
import test from "node:test";
import { renderLaunchAgentPlist } from "../scripts/install-launchd.mjs";

test("renders a safe LaunchAgent plist with absolute runtime paths", () => {
  const xml = renderLaunchAgentPlist({
    nodePath: "/opt/node/bin/node",
    scriptPath: "/Users/nge/project/scripts/run-manager.mjs",
    workingDirectory: "/Users/nge/project",
    dataDir: "/Users/nge/project/data",
  });

  assert.match(xml, /com\.nge\.time-management-master/);
  assert.match(xml, /<string>\/opt\/node\/bin\/node<\/string>/);
  assert.match(xml, /<string>\/Users\/nge\/project\/scripts\/run-manager\.mjs<\/string>/);
  assert.match(xml, /<key>WorkingDirectory<\/key>/);
  assert.match(xml, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(xml, /<key>KeepAlive<\/key>\s*<true\/>/);
  assert.match(xml, /manager\.stdout\.log/);
  assert.match(xml, /manager\.stderr\.log/);
  assert.doesNotMatch(xml, /FEISHU_APP_SECRET|FEISHU_WEBHOOK_SECRET/);
});
