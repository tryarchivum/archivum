// Anthropic Messages API adapter. The engine's canonical message format IS
// Anthropic's block format, so this adapter mostly adds headers, the system
// block and cache_control breakpoints.

import { LlmError, makeRedactor, normalizeUsage, postJson } from "./http.js";

const EPHEMERAL = { type: "ephemeral" };

/** Marks the last block of the last message for caching without mutating history. */
function withMovingCacheBreakpoint(messages) {
  if (messages.length < 2) return messages;
  const last = messages[messages.length - 1];
  if (!Array.isArray(last.content) || last.content.length === 0) return messages;
  const blocks = last.content.slice();
  blocks[blocks.length - 1] = { ...blocks[blocks.length - 1], cache_control: EPHEMERAL };
  return [...messages.slice(0, -1), { ...last, content: blocks }];
}

const toBlocks = (content) => (typeof content === "string" ? [{ type: "text", text: content }] : content);

function mapStop(reason, content) {
  if (reason === "tool_use") return "tool_use";
  if (reason === "max_tokens") return "max_tokens";
  if (reason === "refusal") return "refusal";
  if (reason === "end_turn" || reason === "stop_sequence" || reason === "pause_turn") return "end_turn";
  return content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn";
}

/**
 * @param {{apiKey:string, baseUrl?:string, anthropicVersion?:string}} llm
 * @param {{fetchImpl:typeof fetch, retry?:object}} env
 */
export function createAnthropicProvider(llm, { fetchImpl, retry } = {}) {
  const baseUrl = String(llm.baseUrl || "https://api.anthropic.com").replace(/\/+$/, "");
  const version = llm.anthropicVersion || "2023-06-01";
  const redact = makeRedactor(llm.apiKey);
  return {
    name: "anthropic",
    redact,
    /**
     * @returns {Promise<{content:object[], stopReason:"tool_use"|"end_turn"|"max_tokens"|"refusal", usage:object}>}
     */
    async callModel({ model, system, messages, tools, maxTokens, signal }) {
      const body = {
        model,
        max_tokens: maxTokens,
        system: [{ type: "text", text: system, cache_control: EPHEMERAL }],
        tools,
        messages: withMovingCacheBreakpoint(messages.map((m) => ({ ...m, content: toBlocks(m.content) }))),
      };
      const json = await postJson({
        url: `${baseUrl}/v1/messages`,
        headers: { "x-api-key": llm.apiKey, "anthropic-version": version },
        body,
        label: "Anthropic",
        describeError: (j, text) => ({ type: j?.error?.type ?? "error", message: j?.error?.message ?? text.slice(0, 300) }),
        isBadBody: (j) => j.type === "error",
        fetchImpl,
        signal,
        redact,
        retry,
      });
      const content = (Array.isArray(json.content) ? json.content : []).filter(
        (b) => b && typeof b === "object" && ((b.type === "text" && typeof b.text === "string") || (b.type === "tool_use" && typeof b.name === "string")),
      );
      if (!Array.isArray(json.content)) throw new LlmError("The Anthropic API returned a response without content.", { type: "bad_response", retryable: true });
      return { content, stopReason: mapStop(json.stop_reason, content), usage: normalizeUsage(json.usage) };
    },
  };
}
