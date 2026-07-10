import test from "node:test";
import assert from "node:assert/strict";
import { pickDailyTasks } from "../src/lib/prioritizer.mjs";

test("picks urgent important tasks first", () => {
  const today = new Date(2026, 6, 4);
  const picked = pickDailyTasks(
    [
      { title: "出海研究", importance: "A", urgency: "medium", quadrant: "重要不紧急", due: "2026-07-30", status: "open" },
      { title: "直播 PPT", importance: "S", urgency: "high", quadrant: "重要且紧急", due: "2026-07-08", status: "open" },
      { title: "刷信息流", importance: "C", urgency: "low", quadrant: "不重要不紧急", status: "open" },
    ],
    today,
  );
  assert.equal(picked[0].task.title, "直播 PPT");
});
