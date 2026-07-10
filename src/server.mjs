import http from "node:http";
import { loadConfig } from "./config.mjs";
import { dispatchToday } from "./lib/dispatch.mjs";
import { handleFeishuInbound } from "./lib/feishu-events.mjs";

const config = loadConfig();

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/health") {
      return json(res, 200, { ok: true, service: "time-management-master" });
    }

    if (req.method === "POST" && req.url === "/dispatch/today") {
      const result = await dispatchToday(config);
      return json(res, 200, result);
    }

    if (req.method === "POST" && req.url === "/feishu/events") {
      const body = await readJson(req);
      const result = await handleFeishuInbound(config, body);
      if (result.action === "challenge") return json(res, 200, result.response);
      return json(res, 200, { ok: true, ...result });
    }

    return json(res, 404, { error: "not_found" });
  } catch (error) {
    console.error(error);
    return json(res, 500, { error: error.message });
  }
});

server.listen(config.port, () => {
  console.log(`Time Management Master listening on http://localhost:${config.port}`);
});

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body, null, 2));
}
