import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../src/config.mjs";

test("uses the personal coach time defaults", () => {
  const config = loadConfig({});
  assert.equal(config.schedule.plan, "08:00");
  assert.equal(config.schedule.eveningEnd, "24:00");
  assert.equal(config.schedule.noResponseMinutes, 10);
});
