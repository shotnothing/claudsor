import http from "node:http";
import { callMessages } from "./claude.js";
import {
  responsesToAnthropic,
  anthropicToChatCompletion,
  anthropicToChatCompletionsSSE,
} from "./translate.js";
import { newRequestId, logHttp, logInput, logOutput, logError } from "./logger.js";

const MODELS = [
  "gpt-5.3-codex",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.4-nano",
  "claude-opus-4-7",
  "claude-sonnet-4-6",
  "claude-haiku-4-5",
];

const RESPONSES_PATHS = new Set([
  "/chat/completions",
  "/v1/chat/completions",
  "/v1/responses",
  "/responses",
]);

const MODELS_PATHS = new Set(["/models", "/v1/models"]);

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function writeJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function writeModels(res) {
  const now = Math.floor(Date.now() / 1000);
  writeJson(res, 200, {
    object: "list",
    data: MODELS.map((id) => ({ id, object: "model", created: now, owned_by: "claudsor" })),
  });
}

function parseSseEvent(chunk) {
  let event = "message";
  let data = "";
  for (const line of chunk.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data += line.slice(5).trim();
  }
  let parsed = null;
  if (data) { try { parsed = JSON.parse(data); } catch { parsed = data; } }
  return { event, data: parsed };
}

async function handleResponses(req, res) {
  const reqId = newRequestId();
  const startedAt = Date.now();
  const url = (req.url || "/").split("?")[0];

  let body;
  try {
    const raw = await readBody(req);
    body = raw ? JSON.parse(raw) : {};
  } catch (e) {
    logError({ req_id: reqId, where: "parse_request", message: e.message });
    return writeJson(res, 400, { error: { message: `invalid json: ${e.message}` } });
  }

  logInput({
    req_id: reqId,
    method: req.method,
    path: url,
    model: body?.model,
    stream: body?.stream === true,
    body,
  });

  let anthropicBody;
  try {
    anthropicBody = responsesToAnthropic(body);
  } catch (e) {
    logError({ req_id: reqId, where: "translate_request", message: e.message, stack: e.stack });
    return writeJson(res, 400, { error: { message: `translation failed: ${e.message}` } });
  }

  const stream = anthropicBody.stream === true;

  if (!stream) {
    try {
      const resp = await callMessages(anthropicBody);
      const out = anthropicToChatCompletion(resp, { model: body.model });
      logOutput({
        req_id: reqId,
        mode: "json",
        status: 200,
        ms: Date.now() - startedAt,
        translated_request: anthropicBody,
        anthropic_response: resp,
        response: out,
      });
      return writeJson(res, 200, out);
    } catch (e) {
      logError({ req_id: reqId, where: "anthropic_call", message: String(e.message || e), stack: e.stack });
      return writeJson(res, 502, { error: { message: String(e.message || e) } });
    }
  }

  let upstream;
  try {
    upstream = await callMessages(anthropicBody);
  } catch (e) {
    logError({ req_id: reqId, where: "anthropic_call", message: String(e.message || e), stack: e.stack });
    return writeJson(res, 502, { error: { message: String(e.message || e) } });
  }

  if (!upstream.ok) {
    const text = await upstream.text();
    logError({ req_id: reqId, where: "anthropic_status", status: upstream.status, body: text });
    return writeJson(res, upstream.status, { error: { message: text } });
  }

  res.socket?.setNoDelay?.(true);
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
  });

  const keepalive = setInterval(() => {
    try { res.write(": ping\n\n"); } catch { /* ignore */ }
  }, 15000);

  const events = [];
  let finalResponse = null;

  try {
    for await (const chunk of anthropicToChatCompletionsSSE(upstream, { model: body.model })) {
      const ev = parseSseEvent(chunk);
      events.push(ev);
      if (ev.data?.choices?.[0]?.finish_reason) {
        finalResponse = ev.data;
      }
      if (!res.write(chunk)) {
        await new Promise((r) => res.once("drain", r));
      }
    }
    logOutput({
      req_id: reqId,
      mode: "sse",
      status: 200,
      ms: Date.now() - startedAt,
      translated_request: anthropicBody,
      event_count: events.length,
      event_types: events.reduce((m, e) => ((m[e.event] = (m[e.event] ?? 0) + 1), m), {}),
      final_response: finalResponse,
      events,
    });
  } catch (e) {
    logError({ req_id: reqId, where: "stream", message: String(e.message || e), stack: e.stack });
    try {
      res.write(`event: error\ndata: ${JSON.stringify({ message: String(e.message || e) })}\n\n`);
    } catch { /* ignore */ }
  } finally {
    clearInterval(keepalive);
    res.end();
  }
}

export function startServer(port = Number(process.env.PORT) || 5090) {
  const server = http.createServer(async (req, res) => {
    const url = req.url || "/";
    const pathname = url.split("?")[0];
    const startedAt = Date.now();
    const remote = req.socket?.remoteAddress;

    res.on("finish", () => {
      logHttp({
        method: req.method,
        url,
        path: pathname,
        status: res.statusCode,
        ms: Date.now() - startedAt,
        remote,
        ua: req.headers["user-agent"],
        host: req.headers.host,
        forwarded_for: req.headers["x-forwarded-for"],
      });
    });
    res.on("close", () => {
      if (!res.writableFinished) {
        logHttp({
          method: req.method,
          url,
          path: pathname,
          status: res.statusCode,
          ms: Date.now() - startedAt,
          remote,
          aborted: true,
        });
      }
    });

    try {
      if (req.method === "POST" && RESPONSES_PATHS.has(pathname)) return await handleResponses(req, res);
      if (req.method === "GET" && MODELS_PATHS.has(pathname)) return writeModels(res);
      if (req.method === "GET" && pathname === "/") return writeJson(res, 200, { ok: true, service: "claudsor" });
      if (req.method === "OPTIONS") {
        res.writeHead(204, {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
          "Access-Control-Allow-Headers": "*",
        });
        return res.end();
      }
      writeJson(res, 404, { error: { message: `no route for ${req.method} ${pathname}` } });
    } catch (e) {
      logError({ where: "server_dispatch", path: pathname, method: req.method, message: String(e.message || e), stack: e.stack });
      try { writeJson(res, 500, { error: { message: "internal error" } }); } catch { /* ignore */ }
    }
  });

  server.listen(port, () => {
    console.log(`Responses-compatible endpoint: http://localhost:${port}`);
    console.log(`Logs -> ${process.env.CLAUDSOR_LOG_DIR || "./logs"}/{input,output,errors}.jsonl`);
  });

  return server;
}
