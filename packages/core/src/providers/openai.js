// OpenAI-compatible adapter: POST {baseUrl}/chat/completions with tool calling.
// Works with OpenAI itself and with local routers/gateways that speak the same
// protocol. Converts the canonical Anthropic-style blocks to chat messages and
// back: assistant tool_use <-> `tool_calls`, user tool_result <-> `role:"tool"`.

import { LlmError, makeRedactor, normalizeUsage, postJson } from "./http.js";

/** Tool errors are marked in-band because the tool role has no error flag. */
export const TOOL_ERROR_PREFIX = "ERROR: ";

const textOf = (content) =>
  typeof content === "string"
    ? content
    : (content ?? [])
        .filter((b) => b?.type === "text" && typeof b.text === "string")
        .map((b) => b.text)
        .join("\n");

function toChatMessages(system, messages) {
  const out = [{ role: "system", content: system }];
  for (const m of messages) {
    if (typeof m.content === "string") {
      out.push({ role: m.role, content: m.content });
      continue;
    }
    if (m.role === "assistant") {
      const text = textOf(m.content);
      const calls = m.content
        .filter((b) => b?.type === "tool_use")
        .map((b) => ({ id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } }));
      const msg = { role: "assistant", content: text || (calls.length ? null : "") };
      if (calls.length) msg.tool_calls = calls;
      out.push(msg);
      continue;
    }
    for (const b of m.content) {
      if (b?.type !== "tool_result") continue;
      const body = typeof b.content === "string" ? b.content : textOf(b.content);
      out.push({ role: "tool", tool_call_id: b.tool_use_id, content: b.is_error ? `${TOOL_ERROR_PREFIX}${body}` : body });
    }
    const text = textOf(m.content.filter((b) => b?.type === "text"));
    if (text) out.push({ role: "user", content: text });
  }
  return out;
}

function parseArguments(raw) {
  if (raw && typeof raw === "object") return { input: raw };
  const s = typeof raw === "string" ? raw.trim() : "";
  if (s === "") return { input: {} };
  try {
    const v = JSON.parse(s);
    if (v && typeof v === "object" && !Array.isArray(v)) return { input: v };
    return { input: {}, parse_error: "arguments must be a JSON object" };
  } catch (e) {
    return { input: {}, parse_error: e.message };
  }
}

function usageFrom(u) {
  const prompt = Number.isFinite(u?.prompt_tokens) ? u.prompt_tokens : Number.isFinite(u?.input_tokens) ? u.input_tokens : 0;
  const completion = Number.isFinite(u?.completion_tokens) ? u.completion_tokens : Number.isFinite(u?.output_tokens) ? u.output_tokens : 0;
  const cached = u?.prompt_tokens_details?.cached_tokens ?? u?.cache_read_input_tokens ?? 0;
  const cacheRead = Number.isFinite(cached) && cached > 0 ? Math.min(cached, prompt) : 0;
  const cacheCreate = Number.isFinite(u?.cache_creation_input_tokens) ? u.cache_creation_input_tokens : 0;
  return normalizeUsage({
    input_tokens: Math.max(0, prompt - cacheRead),
    output_tokens: completion,
    cache_read_input_tokens: cacheRead,
    cache_creation_input_tokens: cacheCreate,
  });
}

/**
 * @param {{apiKey?:string, baseUrl?:string}} llm baseUrl includes the version segment, e.g. "http://localhost:20128/v1"
 * @param {{fetchImpl:typeof fetch, retry?:object}} env
 */
export function createOpenAIProvider(llm, { fetchImpl, retry } = {}) {
  const baseUrl = String(llm.baseUrl || "https://api.openai.com/v1").replace(/\/+$/, "");
  const redact = makeRedactor(llm.apiKey);
  let callCounter = 0;
  return {
    name: "openai",
    redact,
    async callModel({ model, system, messages, tools, maxTokens, signal }) {
      const body = {
        model,
        max_tokens: maxTokens,
        messages: toChatMessages(system, messages),
        tools: tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.input_schema } })),
        stream: false,
      };
      const json = await postJson({
        url: `${baseUrl}/chat/completions`,
        headers: llm.apiKey ? { authorization: `Bearer ${llm.apiKey}` } : {},
        body,
        label: "OpenAI-compatible",
        describeError: (j, text) => ({
          type: String(j?.error?.type ?? j?.error?.code ?? "error"),
          message: j?.error?.message ?? (typeof j?.error === "string" ? j.error : text.slice(0, 300)),
        }),
        isBadBody: (j) => !Array.isArray(j.choices) || j.choices.length === 0,
        fetchImpl,
        signal,
        redact,
        retry,
      });
      const choice = json.choices[0];
      const msg = choice?.message ?? {};
      const content = [];
      const text = typeof msg.content === "string" ? msg.content : Array.isArray(msg.content) ? textOf(msg.content) : "";
      if (text) content.push({ type: "text", text });
      for (const call of Array.isArray(msg.tool_calls) ? msg.tool_calls : []) {
        const fn = call?.function;
        if (!fn || typeof fn.name !== "string") continue;
        content.push({ type: "tool_use", id: typeof call.id === "string" && call.id ? call.id : `call_${++callCounter}`, name: fn.name, ...parseArguments(fn.arguments) });
      }
      const hasTools = content.some((b) => b.type === "tool_use");
      const fr = choice?.finish_reason;
      let stopReason = hasTools ? "tool_use" : "end_turn";
      if (fr === "length") stopReason = "max_tokens";
      else if (fr === "content_filter" && !hasTools) stopReason = "refusal";
      if (!choice?.message) throw new LlmError("The OpenAI-compatible API returned a choice without a message.", { type: "bad_response", retryable: true });
      return { content, stopReason, usage: usageFrom(json.usage) };
    },
  };
}
