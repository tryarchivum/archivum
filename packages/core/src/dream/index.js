// Dream engine: pure (no filesystem, no node: APIs). One analyzer agent per
// input, then one organizer, talking to an LLM through a provider adapter
// (Anthropic Messages or any OpenAI-compatible chat-completions endpoint) with
// tool use against a DocsApi (the STAGING wiki).

import { createProvider } from "../providers/index.js";
import { AbortedError, BudgetExhaustedError, LlmError } from "../providers/http.js";
import { scrubSecrets } from "../scrub.js";
import { MAX_PART_CHARS, splitText } from "../split.js";
import { AgentError, runAgent } from "./agent.js";
import { BudgetTracker } from "./budget.js";
import { analyzerFirstContent, analyzerSystem, organizerFirstContent, organizerSystem } from "./prompts.js";
import { createToolbox } from "./tools.js";

export { estimateDream } from "../estimate.js";
export { MAX_PART_CHARS, splitText } from "../split.js";

const DEFAULT_MAX_TURNS = 40;
const DEFAULT_MAX_TOKENS_PER_CALL = 16_000;

/**
 * @param {object} opts
 * @param {{provider:"anthropic"|"openai", apiKey?:string, baseUrl?:string, anthropicVersion?:string}} opts.llm
 *   "openai" = any OpenAI-compatible /chat/completions endpoint with tool calling; `baseUrl`
 *   includes the version segment (e.g. "http://localhost:20128/v1"). The key is optional for "openai".
 * @param {{analyzer:string, organizer:string}} opts.models
 * @param {object} opts.docs DocsApi (MemoryWiki or list/get/write/delete/rename) = staging wiki
 * @param {{id:string, source:string, text:string}[]} opts.transcripts
 * @param {string|null} [opts.instructions]
 * @param {number} opts.budgetTokens
 * @param {number} [opts.concurrency=3]
 * @param {AbortSignal} [opts.signal]
 * @param {(event:object)=>void} [opts.onEvent] every event has `type`, `ts` (ms) and `message`
 * @param {typeof fetch} [opts.fetch]
 * @param {number} [opts.maxTurns=40] per agent
 * @param {number} [opts.maxTokensPerCall=16000]
 * @param {{maxAttempts?:number, baseMs?:number, maxMs?:number, maxRetryAfterMs?:number, requestTimeoutMs?:number}} [opts.retry]
 * @param {string} [opts.today] YYYY-MM-DD used in the prompts
 * @returns {Promise<{
 *   status: "completed"|"budget_exhausted"|"canceled"|"failed",
 *   summary: string,
 *   usage: {input_tokens:number,output_tokens:number,cache_creation_input_tokens:number,cache_read_input_tokens:number,total_tokens:number},
 *   analyzed: {id:string, ok:boolean, summary:string|null, error:string|null}[],
 *   organizer: {ok:boolean, summary:string|null, changes:string[], error:string|null},
 *   error: string|null,
 * }>}
 *
 * Budget: the cap is checked before each model call is launched; calls already in
 * flight finish, so the total can overshoot by at most those calls. Tool calls of
 * a response that has been paid for are still executed (they are local).
 * Never rejects: failures come back as status "failed" with a message that never
 * contains the API key.
 *
 * Events: phase, analyzer_started/done (agent "analyzer:<id>", inputId), organizer_started/done
 * (agent "organizer"), agent_text, tool (agent, tool, path?, ok), usage (cumulative `usage`),
 * budget, error.
 */
export async function runDream(opts) {
  const {
    llm,
    models,
    docs,
    transcripts,
    instructions = null,
    budgetTokens,
    concurrency = 3,
    signal: externalSignal,
    onEvent,
    fetch: fetchImpl = globalThis.fetch,
    maxTurns = DEFAULT_MAX_TURNS,
    maxTokensPerCall = DEFAULT_MAX_TOKENS_PER_CALL,
    retry,
    today = new Date().toISOString().slice(0, 10),
  } = opts ?? {};

  const budget = new BudgetTracker(Number.isFinite(budgetTokens) ? budgetTokens : 0, (pct, used, cap) =>
    emit("budget", `Token budget ${pct}% used (${used} of ${cap}).`, { pct, used, cap }),
  );
  const internal = new AbortController();
  const onExternalAbort = () => internal.abort();
  const analyzed = [];
  let organizer = { ok: false, summary: null, changes: [], error: null };
  let redactFn = (s) => String(s);

  function emit(type, message, extra = {}) {
    if (typeof onEvent !== "function") return;
    try {
      onEvent({ type, ts: Date.now(), message: redactFn(message), ...extra });
    } catch {
      // an event listener must never break a run
    }
  }

  const finish = (status, summary, error = null) => ({
    status,
    summary,
    usage: { ...budget.usage },
    analyzed,
    organizer,
    error: error === null ? null : redactFn(error),
  });

  try {
    const notStarted = (why) => finish("failed", "The dream did not start.", why);
    if (llm?.provider !== "anthropic" && llm?.provider !== "openai") return notStarted('llm.provider must be "anthropic" or "openai".');
    if (llm.provider === "anthropic" && (typeof llm.apiKey !== "string" || llm.apiKey === "")) return notStarted("No Anthropic API key was provided.");
    if (llm.apiKey != null && typeof llm.apiKey !== "string") return notStarted("llm.apiKey must be a string.");
    const apiKey = llm.apiKey || "";
    if (!models?.analyzer || !models?.organizer) return notStarted("Both an analyzer model and an organizer model are required.");
    if (!docs || typeof docs.list !== "function") return notStarted("A document store is required.");
    if (!Array.isArray(transcripts) || transcripts.length === 0) return notStarted("There is nothing to analyze.");
    if (!Number.isFinite(budgetTokens) || budgetTokens <= 0) return notStarted("budgetTokens must be a positive number.");
    if (typeof fetchImpl !== "function") return notStarted("No fetch implementation is available.");

    if (externalSignal?.aborted) return finish("canceled", "Canceled before it started.");
    externalSignal?.addEventListener("abort", onExternalAbort, { once: true });

    const provider = createProvider(llm, { fetchImpl, retry });
    redactFn = provider.redact;
    const stats = { mutations: 0, redactions: 0 };

    const client = {
      /** One budgeted model call. */
      async send(req) {
        if (internal.signal.aborted) throw new AbortedError();
        if (budget.exhausted) throw new BudgetExhaustedError();
        const resp = await provider.callModel({ ...req, signal: internal.signal });
        budget.add(resp.usage);
        emit("usage", `Tokens used so far: ${budget.used} of ${budget.cap}.`, { usage: { ...budget.usage } });
        return resp;
      },
    };
    const systemOpts = { instructions, today };
    const agentOpts = { client, maxTurns, maxTokens: maxTokensPerCall, emit };

    let fatal = null;
    let budgetCut = false;

    // ---- analyzers -------------------------------------------------------
    emit("phase", `Analyzing ${transcripts.length} input(s).`, { phase: "analysis" });

    async function analyzeInput(input) {
      const parts = splitText(String(input.text ?? ""), MAX_PART_CHARS);
      const summaries = [];
      const agent = `analyzer:${input.id}`;
      emit("analyzer_started", `Analyzer started for ${input.id}${parts.length > 1 ? ` (${parts.length} parts)` : ""}.`, { agent, inputId: input.id, parts: parts.length });
      for (let p = 0; p < parts.length; p++) {
        const toolbox = createToolbox({ docs, role: "analyzer", scrub: scrubSecrets, stats });
        const r = await runAgent({
          ...agentOpts,
          agent,
          model: models.analyzer,
          system: analyzerSystem(systemOpts),
          toolbox,
          firstContent: analyzerFirstContent({
            id: input.id,
            source: input.source ?? "transcript",
            part: p + 1,
            parts: parts.length,
            text: parts[p],
            earlierSummaries: summaries,
          }),
        }).catch((e) => {
          if (parts.length > 1 && !(e instanceof AbortedError || e instanceof BudgetExhaustedError)) {
            e.message = `part ${p + 1} of ${parts.length}: ${e.message}`;
          }
          throw e;
        });
        summaries.push(r.summary);
      }
      return parts.length > 1 ? summaries.map((s, i) => `Part ${i + 1}: ${s}`).join("\n") : summaries[0];
    }

    function describeFailure(e) {
      if (e instanceof AbortedError) return { error: "Canceled.", kind: "aborted" };
      if (e instanceof BudgetExhaustedError) return { error: "Token budget exhausted before this agent finished.", kind: "budget" };
      if (e instanceof LlmError || e instanceof AgentError) return { error: redactFn(e.message), kind: e instanceof LlmError && e.fatal ? "fatal" : "agent" };
      return { error: redactFn(`Unexpected error: ${e?.message ?? e}`), kind: "agent" };
    }

    const slots = new Array(transcripts.length).fill(null);
    let next = 0;
    async function worker() {
      while (next < transcripts.length) {
        const i = next++;
        const input = transcripts[i];
        if (internal.signal.aborted || budget.exhausted) {
          slots[i] = { id: input.id, ok: false, summary: null, error: internal.signal.aborted ? "Not run: canceled." : "Not run: token budget exhausted." };
          if (!internal.signal.aborted) budgetCut = true;
          continue;
        }
        const agent = `analyzer:${input.id}`;
        try {
          const summary = await analyzeInput(input);
          slots[i] = { id: input.id, ok: true, summary, error: null };
          emit("analyzer_done", `Analyzer finished for ${input.id}.`, { agent, inputId: input.id, ok: true });
        } catch (e) {
          const { error, kind } = describeFailure(e);
          slots[i] = { id: input.id, ok: false, summary: null, error };
          if (kind === "budget") budgetCut = true;
          if (kind === "fatal" && !fatal) {
            fatal = error;
            internal.abort();
          }
          if (kind !== "aborted") emit("error", `Analyzer ${input.id} failed: ${error}`, { agent, inputId: input.id });
          emit("analyzer_done", `Analyzer ${input.id} did not finish.`, { agent, inputId: input.id, ok: false });
        }
      }
    }
    const width = Math.max(1, Math.min(Math.floor(Number(concurrency)) || 1, transcripts.length));
    await Promise.all(Array.from({ length: width }, worker));
    analyzed.push(...slots);

    const canceled = () => externalSignal?.aborted === true;
    if (canceled()) return finish("canceled", "Canceled during analysis.");
    if (fatal) return finish("failed", "The dream stopped because the LLM API rejected the request.", fatal);

    const okCount = analyzed.filter((a) => a.ok).length;
    if (okCount === 0 && !budgetCut) {
      const first = analyzed.find((a) => a.error)?.error ?? "unknown error";
      return finish("failed", "Every analyzer failed.", `All ${analyzed.length} analyzer(s) failed. First error: ${first}`);
    }

    // ---- organizer -------------------------------------------------------
    if (budgetCut || budget.exhausted) {
      organizer = { ok: false, summary: null, changes: [], error: "Skipped: token budget exhausted before the organizer could run." };
      emit("budget", "Token budget exhausted; the organizer was skipped.", { used: budget.used, cap: budget.cap });
      return finish("budget_exhausted", summarize(analyzed, organizer, true), null);
    }

    const docCount = docs.list().length;
    if (docCount === 0 || stats.mutations === 0) {
      organizer = {
        ok: true,
        summary: docCount === 0 ? "Nothing to organize: there are no documents." : "Organizer skipped: the analyzers changed no documents.",
        changes: [],
        error: null,
      };
      return finish("completed", summarize(analyzed, organizer, false));
    }

    emit("phase", "Organizing the wiki.", { phase: "organizer" });
    emit("organizer_started", `Organizer started over ${docCount} document(s).`, { agent: "organizer" });
    try {
      const r = await runAgent({
        ...agentOpts,
        agent: "organizer",
        model: models.organizer,
        system: organizerSystem(systemOpts),
        toolbox: createToolbox({ docs, role: "organizer", scrub: scrubSecrets, stats }),
        firstContent: organizerFirstContent({ analyzed, docCount }),
      });
      organizer = { ok: true, summary: r.summary, changes: r.submission?.changes ?? [], error: null };
      emit("organizer_done", "Organizer finished.", { agent: "organizer", ok: true });
    } catch (e) {
      const { error, kind } = describeFailure(e);
      organizer = { ok: false, summary: null, changes: [], error };
      emit("organizer_done", "Organizer did not finish.", { agent: "organizer", ok: false });
      if (kind === "aborted" && canceled()) return finish("canceled", "Canceled during organizing.");
      if (kind === "budget") return finish("budget_exhausted", summarize(analyzed, organizer, true));
      emit("error", `Organizer failed: ${error}`, { agent: "organizer" });
      return finish("failed", "The organizer failed.", `Organizer failed: ${error}`);
    }
    return finish("completed", summarize(analyzed, organizer, false));
  } catch (e) {
    const msg = redactFn(e?.message ?? e);
    if (externalSignal?.aborted) return finish("canceled", "Canceled.");
    return finish("failed", "The dream failed unexpectedly.", `Unexpected error: ${msg}`);
  } finally {
    externalSignal?.removeEventListener("abort", onExternalAbort);
  }
}

function summarize(analyzed, organizer, partial) {
  const ok = analyzed.filter((a) => a.ok).length;
  const lines = [`Analyzed ${ok} of ${analyzed.length} input(s)${partial ? "; stopped early because the token budget ran out" : ""}.`];
  if (organizer.ok && organizer.summary) lines.push(`Organizer: ${organizer.summary}`);
  else if (organizer.error) lines.push(`Organizer: ${organizer.error}`);
  const reports = analyzed.filter((a) => a.ok && a.summary).map((a) => `- ${a.id}: ${a.summary.replace(/\s+/g, " ").slice(0, 400)}`);
  if (reports.length) lines.push(...reports);
  return lines.join("\n");
}
