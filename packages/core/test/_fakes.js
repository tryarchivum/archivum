// Local fakes of the Anthropic Messages API and of an OpenAI-compatible
// /chat/completions endpoint (node:http, no network). Both expose the SAME
// handler contract so the engine tests run unchanged against each:
//
//   const fake = await startFake("anthropic" | "openai", async (ctx) => [use("list_docs", {})]);
//
// The handler gets a provider-neutral ctx and returns one of
//   - an array of content blocks (text(...) / use(...))  -> 200 completion
//   - { content, usage?, stop_reason? }                   -> 200 completion
//   - { status, headers?, error:{type,message} }          -> HTTP error in the provider's format
//   - HANG                                                -> never answers (abort tests)
// ctx = { n, turn, body, headers, agent, system, firstUser, lastUserText, results, toolNames, toolCallsInHistory }
//   results: tool results of the last turn, `[{tool_use_id, content, is_error}]` (OpenAI's in-band "ERROR: " prefix is normalised).
// It may be async, which lets tests order concurrent agents.

import http from "node:http";

export const KEY = "sk-ant-api03-TESTKEYTESTKEYTESTKEY1234";
export const HANG = Symbol("hang");
export const KINDS = ["anthropic", "openai"];

let toolCounter = 0;
export const text = (t) => ({ type: "text", text: t });
export const use = (name, input = {}, id) => ({ type: "tool_use", id: id ?? `call_${++toolCounter}`, name, input });

export const DEFAULT_USAGE = { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };

const ERR_PREFIX = "ERROR: ";

const blocksText = (content) => (typeof content === "string" ? content : (content ?? []).map((b) => b.text ?? "").join("\n"));

/** Normalises a request body of either provider. */
function normalize(kind, body) {
  if (!body || !Array.isArray(body.messages)) {
    return { system: "", firstUser: "", lastUserText: "", results: [], toolNames: [], toolCallsInHistory: 0, turn: 0 };
  }
  const msgs = body.messages;
  if (kind === "anthropic") {
    const system = (Array.isArray(body.system) ? body.system : [{ text: String(body.system ?? "") }]).map((b) => b.text).join("\n");
    const last = msgs.at(-1);
    return {
      system,
      firstUser: blocksText(msgs[0]?.content),
      lastUserText: last?.role === "user" ? blocksText(Array.isArray(last.content) ? last.content.filter((b) => b.type === "text") : last.content) : "",
      results: last?.role === "user" && Array.isArray(last.content) ? last.content.filter((b) => b.type === "tool_result").map((b) => ({ tool_use_id: b.tool_use_id, content: blocksText(b.content), is_error: b.is_error === true })) : [],
      toolNames: (body.tools ?? []).map((t) => t.name),
      toolCallsInHistory: msgs.reduce((n, m) => n + (Array.isArray(m.content) ? m.content.filter((b) => b.type === "tool_use").length : 0), 0),
      turn: msgs.filter((m) => m.role === "assistant").length,
    };
  }
  const system = msgs.find((m) => m.role === "system")?.content ?? "";
  const rest = msgs.filter((m) => m.role !== "system");
  const lastAsst = rest.map((m) => m.role).lastIndexOf("assistant");
  const tail = rest.slice(lastAsst + 1);
  return {
    system,
    firstUser: blocksText(rest[0]?.content),
    lastUserText: rest.at(-1)?.role === "user" ? blocksText(rest.at(-1).content) : "",
    results: tail
      .filter((m) => m.role === "tool")
      .map((m) => ({ tool_use_id: m.tool_call_id, content: m.content.startsWith(ERR_PREFIX) ? m.content.slice(ERR_PREFIX.length) : m.content, is_error: m.content.startsWith(ERR_PREFIX) })),
    toolNames: (body.tools ?? []).map((t) => t.function.name),
    toolCallsInHistory: rest.reduce((n, m) => n + (m.tool_calls?.length ?? 0), 0),
    turn: rest.filter((m) => m.role === "assistant").length,
  };
}

function agentOf(n) {
  if (n.system.includes("Your role: organizer")) return "organizer";
  return /Input id: (\S+)/.exec(n.firstUser)?.[1] ?? "unknown";
}

function anthropicMessage(content, { stop_reason, usage } = {}) {
  const hasTool = content.some((b) => b.type === "tool_use");
  return {
    id: "msg_fake",
    type: "message",
    role: "assistant",
    model: "claude-fake",
    content,
    stop_reason: stop_reason ?? (hasTool ? "tool_use" : "end_turn"),
    stop_sequence: null,
    usage: { ...DEFAULT_USAGE, ...usage },
  };
}

function openaiCompletion(content, { stop_reason, usage } = {}) {
  const u = { ...DEFAULT_USAGE, ...usage };
  const textPart = content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
  const calls = content
    .filter((b) => b.type === "tool_use")
    .map((b) => ({ id: b.id, type: "function", function: { name: b.name, arguments: b.raw_arguments ?? JSON.stringify(b.input) } }));
  const finish = stop_reason === "max_tokens" ? "length" : calls.length ? "tool_calls" : "stop";
  const prompt = u.input_tokens + u.cache_read_input_tokens;
  return {
    id: "chatcmpl-fake",
    object: "chat.completion",
    model: "gpt-fake",
    choices: [{ index: 0, finish_reason: finish, message: { role: "assistant", content: textPart || null, ...(calls.length ? { tool_calls: calls } : {}) } }],
    usage: { prompt_tokens: prompt, completion_tokens: u.output_tokens, total_tokens: prompt + u.output_tokens, prompt_tokens_details: { cached_tokens: u.cache_read_input_tokens } },
  };
}

export async function startFake(kind, handler) {
  const requests = [];
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", async () => {
      let body = null;
      try {
        body = JSON.parse(raw);
      } catch {
        // leave null
      }
      const n = requests.length;
      const norm = normalize(kind, body);
      const ctx = { n, body, headers: req.headers, url: req.url, method: req.method, ...norm, agent: agentOf(norm) };
      requests.push(ctx);
      let out;
      try {
        out = await handler(ctx);
      } catch (e) {
        out = { status: 500, error: { type: "api_error", message: `fake handler threw: ${e.message}` } };
      }
      if (out === HANG) return;
      let status = 200;
      let headers = {};
      let json;
      if (out && out.error) {
        status = out.status ?? 500;
        headers = out.headers ?? {};
        json = kind === "anthropic" ? { type: "error", error: out.error } : { error: { ...out.error, code: out.error.type } };
      } else {
        const content = Array.isArray(out) ? out : out.content;
        json = (kind === "anthropic" ? anthropicMessage : openaiCompletion)(content, Array.isArray(out) ? {} : out);
      }
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(json));
    });
  });
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  const origin = `http://127.0.0.1:${port}`;
  return {
    kind,
    origin,
    baseUrl: kind === "anthropic" ? origin : `${origin}/v1`,
    /** the `llm` option for runDream */
    llm: { provider: kind, apiKey: KEY, baseUrl: kind === "anthropic" ? origin : `${origin}/v1` },
    requests,
    async close() {
      for (const s of sockets) s.destroy();
      await new Promise((r) => server.close(r));
    },
  };
}

/** Resolves when `predicate()` is true, polling every few ms (test synchronisation). */
export async function until(predicate, timeoutMs = 5000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("until: timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}
