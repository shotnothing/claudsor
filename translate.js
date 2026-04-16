import crypto from "node:crypto";

const CLAUDE_CODE_PREAMBLE = "You are Claude Code, Anthropic's official CLI for Claude.";

const EFFORT_BUDGET = { minimal: 0, low: 1024, medium: 4096, high: 16000 };

const FINISH_REASON = {
  end_turn: "stop",
  stop_sequence: "stop",
  max_tokens: "length",
  tool_use: "tool_calls",
};

export function mapModel(name) {
  if (!name) return "claude-sonnet-4-6";
  if (name.startsWith("claude-")) return name;
  if (/-codex$/i.test(name)) return "claude-opus-4-7";
  if (/-(nano|mini)$/i.test(name)) return "claude-haiku-4-5";
  return "claude-sonnet-4-6";
}

function textFromContent(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return String(content);
  return content
    .map((p) => {
      if (typeof p === "string") return p;
      if (p?.type === "input_text" || p?.type === "output_text" || p?.type === "text") return p.text ?? "";
      return "";
    })
    .join("");
}

function userContentBlocks(content) {
  if (content == null) return [{ type: "text", text: "" }];
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (!Array.isArray(content)) return [{ type: "text", text: String(content) }];
  const blocks = [];
  for (const p of content) {
    if (typeof p === "string") {
      blocks.push({ type: "text", text: p });
    } else if (p?.type === "input_text" || p?.type === "text") {
      blocks.push({ type: "text", text: p.text ?? "" });
    } else if (p?.type === "input_image" && p.image_url) {
      const url = typeof p.image_url === "string" ? p.image_url : p.image_url.url;
      blocks.push({ type: "image", source: { type: "url", url } });
    }
  }
  return blocks.length ? blocks : [{ type: "text", text: "" }];
}

function pushAssistantMessage(messages, blocks) {
  if (!blocks.length) return;
  const last = messages[messages.length - 1];
  if (last?.role === "assistant") {
    last.content.push(...blocks);
  } else {
    messages.push({ role: "assistant", content: blocks });
  }
}

function pushUserMessage(messages, blocks) {
  if (!blocks.length) return;
  const last = messages[messages.length - 1];
  if (last?.role === "user") {
    last.content.push(...blocks);
  } else {
    messages.push({ role: "user", content: blocks });
  }
}

function chatMessagesToAnthropic(messages) {
  const systemBlocks = [];
  const out = [];
  for (const m of messages) {
    if (!m) continue;
    if (m.role === "system" || m.role === "developer") {
      const t = textFromContent(m.content);
      if (t) systemBlocks.push({ type: "text", text: t });
      continue;
    }
    if (m.role === "tool") {
      pushUserMessage(out, [
        {
          type: "tool_result",
          tool_use_id: m.tool_call_id,
          content: typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? ""),
        },
      ]);
      continue;
    }
    if (m.role === "assistant") {
      const blocks = [];
      const t = textFromContent(m.content);
      if (t) blocks.push({ type: "text", text: t });
      for (const tc of m.tool_calls ?? []) {
        let parsed = {};
        try { parsed = tc.function?.arguments ? JSON.parse(tc.function.arguments) : {}; } catch { parsed = {}; }
        blocks.push({ type: "tool_use", id: tc.id, name: tc.function?.name, input: parsed });
      }
      pushAssistantMessage(out, blocks);
      continue;
    }
    if (m.role === "user") {
      pushUserMessage(out, userContentBlocks(m.content));
      continue;
    }
  }
  return { systemBlocks, messages: out };
}

function responsesInputToAnthropic(input) {
  const systemBlocks = [];
  const out = [];
  for (const item of input) {
    if (!item || typeof item !== "object") continue;

    if (item.type === "function_call") {
      let parsed = {};
      try { parsed = item.arguments ? JSON.parse(item.arguments) : {}; } catch { parsed = {}; }
      pushAssistantMessage(out, [
        { type: "tool_use", id: item.call_id || item.id, name: item.name, input: parsed },
      ]);
      continue;
    }

    if (item.type === "function_call_output") {
      pushUserMessage(out, [
        {
          type: "tool_result",
          tool_use_id: item.call_id,
          content: typeof item.output === "string" ? item.output : JSON.stringify(item.output ?? ""),
        },
      ]);
      continue;
    }

    if (item.type === "reasoning") continue;

    if (item.role === "system" || item.role === "developer") {
      const t = textFromContent(item.content);
      if (t) systemBlocks.push({ type: "text", text: t });
      continue;
    }

    if (item.role === "user") {
      pushUserMessage(out, userContentBlocks(item.content));
      continue;
    }

    if (item.role === "assistant") {
      const t = textFromContent(item.content);
      if (t) pushAssistantMessage(out, [{ type: "text", text: t }]);
      continue;
    }
  }
  return { systemBlocks, messages: out };
}

function mapTools(rawTools) {
  if (!Array.isArray(rawTools) || !rawTools.length) return undefined;
  const tools = rawTools
    .filter((t) => t && (t.type === "function" || t.function || t.name))
    .map((t) => {
      const fn = t.function ?? t;
      return {
        name: fn.name,
        description: fn.description ?? "",
        input_schema: fn.parameters ?? { type: "object", properties: {} },
      };
    });
  if (tools.length) tools[tools.length - 1].cache_control = { type: "ephemeral" };
  return tools.length ? tools : undefined;
}

export function responsesToAnthropic(body) {
  const preamble = [{ type: "text", text: CLAUDE_CODE_PREAMBLE }];
  if (body.instructions) preamble.push({ type: "text", text: String(body.instructions) });

  let built;
  if (Array.isArray(body.input)) {
    built = responsesInputToAnthropic(body.input);
  } else if (Array.isArray(body.messages)) {
    built = chatMessagesToAnthropic(body.messages);
  } else {
    built = { systemBlocks: [], messages: [] };
  }

  const systemBlocks = [...preamble, ...built.systemBlocks];
  const messages = built.messages;
  if (!messages.length) messages.push({ role: "user", content: [{ type: "text", text: "" }] });
  systemBlocks[systemBlocks.length - 1].cache_control = { type: "ephemeral" };

  const tools = mapTools(body.tools);

  const out = {
    model: mapModel(body.model),
    system: systemBlocks,
    messages,
    max_tokens: body.max_output_tokens ?? body.max_tokens ?? 8192,
    stream: body.stream === true,
  };
  if (tools) out.tools = tools;
  if (typeof body.temperature === "number") out.temperature = body.temperature;
  if (typeof body.top_p === "number") out.top_p = body.top_p;
  if (Array.isArray(body.stop) && body.stop.length) out.stop_sequences = body.stop;

  const effort = body.reasoning?.effort;
  const budget = effort ? EFFORT_BUDGET[effort] ?? 0 : 0;
  if (budget > 0) {
    out.thinking = { type: "enabled", budget_tokens: budget };
    if (out.max_tokens < budget + 2048) out.max_tokens = budget + 2048;
  }

  return out;
}

function newChatCmplId() {
  return "chatcmpl-" + crypto.randomBytes(12).toString("hex");
}

function sseData(data) {
  return `data: ${JSON.stringify(data)}\n\n`;
}

function safeParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}

async function* iterSseLines(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      let event = "message";
      let data = "";
      for (const line of chunk.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data += line.slice(5).trim();
      }
      if (data) yield { event, data: safeParse(data) };
    }
  }
}

export function anthropicToChatCompletion(resp, { model, id }) {
  const chatId = id || newChatCmplId();
  const created = Math.floor(Date.now() / 1000);
  let content = "";
  const toolCalls = [];
  for (const block of resp.content ?? []) {
    if (block.type === "text") content += block.text;
    else if (block.type === "tool_use") {
      toolCalls.push({
        id: block.id,
        type: "function",
        function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
      });
    }
  }
  const message = { role: "assistant", content: content || null };
  if (toolCalls.length) message.tool_calls = toolCalls;
  const finishReason = toolCalls.length
    ? "tool_calls"
    : FINISH_REASON[resp.stop_reason] ?? "stop";
  return {
    id: chatId,
    object: "chat.completion",
    created,
    model: model || resp.model,
    choices: [{ index: 0, message, finish_reason: finishReason, logprobs: null }],
    usage: {
      prompt_tokens: resp.usage?.input_tokens ?? 0,
      completion_tokens: resp.usage?.output_tokens ?? 0,
      total_tokens: (resp.usage?.input_tokens ?? 0) + (resp.usage?.output_tokens ?? 0),
    },
  };
}

export async function* anthropicToChatCompletionsSSE(upstream, { model, id }) {
  const chatId = id || newChatCmplId();
  const created = Math.floor(Date.now() / 1000);

  const baseChunk = (delta, finishReason = null) => ({
    id: chatId,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  });

  yield sseData(baseChunk({ role: "assistant", content: "" }));

  let stopReason = "end_turn";
  let sawToolUse = false;
  const usage = { input_tokens: 0, output_tokens: 0 };
  const activeBlocks = {};
  const toolIndexByBlock = {};
  let nextToolIndex = 0;

  for await (const ev of iterSseLines(upstream)) {
    const d = ev.data;
    if (!d) continue;

    if (ev.event === "message_start") {
      if (d.message?.usage) usage.input_tokens = d.message.usage.input_tokens ?? 0;
      continue;
    }

    if (ev.event === "content_block_start") {
      const block = d.content_block;
      const blockIdx = d.index;
      if (block.type === "text") {
        activeBlocks[blockIdx] = { kind: "text" };
      } else if (block.type === "tool_use") {
        sawToolUse = true;
        const toolIdx = nextToolIndex++;
        toolIndexByBlock[blockIdx] = toolIdx;
        activeBlocks[blockIdx] = { kind: "tool" };
        yield sseData(baseChunk({
          tool_calls: [{
            index: toolIdx,
            id: block.id,
            type: "function",
            function: { name: block.name, arguments: "" },
          }],
        }));
      }
      continue;
    }

    if (ev.event === "content_block_delta") {
      const blockIdx = d.index;
      const active = activeBlocks[blockIdx];
      if (!active) continue;
      const delta = d.delta;
      if (delta.type === "text_delta" && active.kind === "text") {
        yield sseData(baseChunk({ content: delta.text }));
      } else if (delta.type === "input_json_delta" && active.kind === "tool") {
        const toolIdx = toolIndexByBlock[blockIdx];
        yield sseData(baseChunk({
          tool_calls: [{
            index: toolIdx,
            function: { arguments: delta.partial_json ?? "" },
          }],
        }));
      }
      continue;
    }

    if (ev.event === "content_block_stop") {
      delete activeBlocks[d.index];
      continue;
    }

    if (ev.event === "message_delta") {
      if (d.delta?.stop_reason) stopReason = d.delta.stop_reason;
      if (d.usage) usage.output_tokens = d.usage.output_tokens ?? usage.output_tokens;
      continue;
    }

    if (ev.event === "message_stop") {
      const finishReason = sawToolUse ? "tool_calls" : FINISH_REASON[stopReason] ?? "stop";
      const finalChunk = baseChunk({}, finishReason);
      finalChunk.usage = {
        prompt_tokens: usage.input_tokens,
        completion_tokens: usage.output_tokens,
        total_tokens: usage.input_tokens + usage.output_tokens,
      };
      yield sseData(finalChunk);
      yield "data: [DONE]\n\n";
      return;
    }
  }
}
