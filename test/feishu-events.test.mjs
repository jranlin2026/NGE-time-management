import assert from "node:assert/strict";
import test from "node:test";
import {
  extractMessageText,
  selectReplyDestination,
  handleFeishuInbound,
  isDispatchCommand,
  isPlanQuery,
  isProcrastinationSignal,
  isTaskLike,
  normalizeEvidenceMessage,
} from "../src/lib/feishu-events.mjs";

test("normalizes a submitted result URL as evidence", () => {
  assert.deepEqual(normalizeEvidenceMessage("提交结果：发布视频｜https://example.com/v/1").evidence, [
    { type: "url", value: "https://example.com/v/1" },
  ]);
});

test("extracts an unreadable Feishu image as a manual-review reference", () => {
  const result = extractMessageText({ event: { message: {
    message_id: "om_image", message_type: "image", content: JSON.stringify({ image_key: "img_v2_1" }),
  } } });
  assert.equal(result.kind, "message");
  assert.equal(result.evidence[0].type, "feishu_image");
  assert.equal(result.evidence[0].value, "img_v2_1");
});

test("extracts text from Feishu message event", () => {
  const result = extractMessageText({
    event: {
      sender: { sender_id: { user_id: "192b6gd8" } },
      message: {
        message_id: "om_test",
        chat_id: "oc_test",
        message_type: "text",
        content: JSON.stringify({ text: "今日任务" }),
      },
    },
  });

  assert.equal(result.kind, "message");
  assert.equal(result.text, "今日任务");
  assert.equal(result.messageId, "om_test");
  assert.equal(result.chatId, "oc_test");
  assert.equal(result.senderId, "192b6gd8");
});

test("prefers open_id for a reusable personal message destination", () => {
  const result = extractMessageText({
    event: {
      sender: { sender_id: { user_id: "user-1", open_id: "ou_1" } },
      message: { message_id: "om_1", message_type: "text", content: JSON.stringify({ text: "帮助" }) },
    },
  });
  assert.equal(result.senderId, "ou_1");
});

test("uses the source group as the reply destination", () => {
  assert.deepEqual(
    selectReplyDestination({ chatId: "oc_group", senderId: "ou_owner" }),
    { receiveId: "oc_group", receiveIdType: "chat_id" },
  );
  assert.deepEqual(
    selectReplyDestination({ chatId: "", senderId: "ou_owner" }),
    { receiveId: "ou_owner", receiveIdType: "open_id" },
  );
});

test("detects dispatch commands", () => {
  assert.equal(isDispatchCommand("今日任务"), true);
  assert.equal(isDispatchCommand("dispatch"), true);
  assert.equal(isDispatchCommand("新增：测试任务"), false);
});

test("handles challenge response", async () => {
  const result = await handleFeishuInbound({}, { challenge: "abc" });
  assert.deepEqual(result, { action: "challenge", response: { challenge: "abc" } });
});

test("dispatches when receiving 今日任务", async () => {
  const result = await handleFeishuInbound(
    {},
    "今日任务",
    {
      dispatchToday: async () => ({ ok: true, picked: ["A"] }),
      sendText: async () => ({ ok: true }),
    },
  );

  assert.equal(result.action, "dispatch");
  assert.deepEqual(result.result.picked, ["A"]);
});

test("ingests ordinary text as a task", async () => {
  const result = await handleFeishuInbound(
    { kbDir: "kb" },
    "新增：7月8日前确认直播海报",
    {
      ingestTask: async (kbDir, text) => ({
        title: text,
        project: kbDir,
        quadrant: "重要紧急",
      }),
      sendText: async () => ({ ok: true }),
    },
  );

  assert.equal(result.action, "ingest");
  assert.equal(result.task.title, "7月8日前确认直播海报");
  assert.equal(result.task.project, "kb");
});

test("handles done feedback without ingesting a task", async () => {
  const result = await handleFeishuInbound(
    {},
    "完成：直播海报确认",
    {
      sendText: async () => ({ ok: true }),
    },
  );

  assert.equal(result.action, "done");
  assert.equal(result.title, "直播海报确认");
});

test("handles blocked feedback without ingesting a task", async () => {
  const result = await handleFeishuInbound(
    {},
    "卡住：直播演练 不知道怎么开口",
    {
      sendText: async () => ({ ok: true }),
    },
  );

  assert.equal(result.action, "blocked");
  assert.equal(result.detail, "直播演练 不知道怎么开口");
});

test("detects procrastination signals", () => {
  assert.equal(isProcrastinationSignal("我今天状态不好，不想做直播演练"), true);
  assert.equal(isProcrastinationSignal("我想先整理知识库"), true);
  assert.equal(isProcrastinationSignal("新增：确认直播海报"), false);
});

test("detects task-like natural language", () => {
  assert.equal(isTaskLike("我要完成下周直播海报确认"), true);
  assert.equal(isTaskLike("新增：确认直播海报"), true);
  assert.equal(isTaskLike("我有点烦"), false);
});

test("detects plan queries before task ingestion", () => {
  assert.equal(isPlanQuery("我们明天任务是什么"), true);
  assert.equal(isPlanQuery("今天有什么安排"), true);
  assert.equal(isPlanQuery("新增：明天确认直播海报"), false);
});

test("answers plan query without ingesting it", async () => {
  let ingested = false;
  const result = await handleFeishuInbound(
    { kbDir: "kb" },
    "我们明天任务是什么",
    {
      readTasks: async () => [
        {
          id: "1",
          title: "直播准备",
          status: "open",
          importance: "A",
          urgency: "high",
          quadrant: "重要紧急",
          nextAction: "确认助教控场脚本",
          due: "2026-07-08",
        },
      ],
      pickDailyTasks: (tasks) => [{ task: tasks[0], score: 100 }],
      ingestTask: async () => {
        ingested = true;
      },
      sendText: async () => ({ ok: true }),
    },
  );

  assert.equal(result.action, "plan_query");
  assert.equal(result.label, "明天");
  assert.deepEqual(result.picked, ["直播准备"]);
  assert.equal(ingested, false);
});

test("coaches procrastination instead of ingesting it", async () => {
  let ingested = false;
  const result = await handleFeishuInbound(
    { kbDir: "kb" },
    "我今天状态不好，不想做直播演练",
    {
      readTasks: async () => [
        {
          id: "1",
          title: "直播演练",
          status: "open",
          importance: "A",
          urgency: "high",
          quadrant: "重要紧急",
          nextAction: "打开直播大纲，先说前 3 分钟开场",
        },
      ],
      pickDailyTasks: (tasks) => [{ task: tasks[0], score: 100 }],
      ingestTask: async () => {
        ingested = true;
      },
      sendText: async () => ({ ok: true }),
    },
  );

  assert.equal(result.action, "coach_procrastination");
  assert.equal(result.focus.title, "直播演练");
  assert.equal(ingested, false);
});

test("guards non-task chat from entering task pool", async () => {
  let ingested = false;
  const result = await handleFeishuInbound(
    { kbDir: "kb" },
    "我有点烦",
    {
      ingestTask: async () => {
        ingested = true;
      },
      sendText: async () => ({ ok: true }),
    },
  );

  assert.equal(result.action, "conversation_guardrail");
  assert.equal(ingested, false);
});

test("marks matching task done", async () => {
  let saved;
  const result = await handleFeishuInbound(
    { kbDir: "kb" },
    "完成：直播演练",
    {
      readTasks: async () => [{ id: "1", title: "直播演练", status: "open", procrastinationCount: 0 }],
      writeTasks: async (_kbDir, tasks) => {
        saved = tasks;
      },
      sendText: async () => ({ ok: true }),
    },
  );

  assert.equal(result.action, "done");
  assert.equal(result.update.matched, true);
  assert.equal(saved[0].status, "done");
});
