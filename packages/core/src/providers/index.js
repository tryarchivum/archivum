import { createAnthropicProvider } from "./anthropic.js";
import { createOpenAIProvider } from "./openai.js";

export { createAnthropicProvider, createOpenAIProvider };
export { AbortedError, BudgetExhaustedError, LlmError, normalizeUsage, zeroUsage } from "./http.js";

/**
 * @param {{provider:"anthropic"|"openai", apiKey?:string, baseUrl?:string, anthropicVersion?:string}} llm
 * @param {{fetchImpl:typeof fetch, retry?:object}} env
 */
export function createProvider(llm, env) {
  if (llm?.provider === "anthropic") return createAnthropicProvider(llm, env);
  if (llm?.provider === "openai") return createOpenAIProvider(llm, env);
  throw new Error(`Unknown LLM provider "${llm?.provider}". Use "anthropic" or "openai".`);
}
