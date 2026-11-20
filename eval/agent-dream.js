// Eval of the "agent dream" path (dream_prepare -> the agent writes pages -> dream_submit -> apply), the path a user
// on a Claude or Codex subscription takes. A chat model plays the agent through an OpenAI-compatible endpoint; it sees
// exactly what an MCP client would see: the text dream_prepare returns and one tool, dream_submit.
//
//   node eval/agent-dream.js --scenario quillon --base-url URL --model NAME [--qa-model NAME]
//   API key: OPENAI_API_KEY or ARCHIVUM_LLM_API_KEY.  Never printed.
//
// Same scoring as eval/run.js (scoreDocs on the applied wiki) and, with --qa, the same question matrix.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { Store } from "../packages/cli/src/store.js";
import { callTool } from "../packages/cli/src/mcp.js";
import { applyProposal } from "../packages/cli/src/proposals.js";
import { loadFixtures, makeAsk, listScenarios, parseTranscript } from "./run.js";
import { scoreDocs } from "./score.js";
import { makeContexts, runQaMatrix, renderQaTable, contextRecall } from "./baselines.js";

const SUBMIT_TOOL = {
  type: "function",
  function: {
    name: "dream_submit",
    description: "Finish the dream: the COMPLETE new content of every wiki document you create or change (always include /_index.md), and paths to delete.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string" },
        documents: { type: "array", items: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } },
        delete: { type: "array", items: { type: "string" } },
        summary: { type: "string" },
      },
      required: ["id", "documents"],
    },
  },
};

async function chat({ baseUrl, apiKey, model, messages, tools, maxTokens = 16000 }) {
  const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, stream: false, max_tokens: maxTokens, messages, tools, tool_choice: "auto" }),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`LLM ${res.status}: ${body.slice(0, 200)}`);
  return JSON.parse(body);
}

/** Runs the agent loop: the model gets the dream_prepare text and may call dream_submit (up to `turns` attempts, as a real agent would after an error). */
export async function agentDream({ store, llm, turns = 3, log = () => {} }) {
  const prep = callTool(store, "dream_prepare", {});
  const prepared = prep.content[0].text;
  const messages = [
    { role: "system", content: "You are a coding agent with long-term memory tools. The user asked you to run a memory dream. Follow the instructions you receive, then call dream_submit." },
    { role: "user", content: `Run an Archivum dream now. Here is what dream_prepare returned:\n\n${prepared}` },
  ];
  const usage = { prompt: 0, completion: 0 };
  let last = null;
  for (let t = 1; t <= turns; t++) {
    const r = await chat({ ...llm, messages, tools: [SUBMIT_TOOL] });
    usage.prompt += r.usage?.prompt_tokens ?? 0;
    usage.completion += r.usage?.completion_tokens ?? 0;
    const msg = r.choices?.[0]?.message;
    const call = msg?.tool_calls?.find((c) => c.function?.name === "dream_submit");
    if (!call) {
      log(`turn ${t}: no dream_submit call`);
      messages.push({ role: "assistant", content: msg?.content ?? "" }, { role: "user", content: "Call dream_submit now with the full new document contents." });
      continue;
    }
    let args;
    try {
      args = JSON.parse(call.function.arguments);
    } catch {
      messages.push(msg, { role: "tool", tool_call_id: call.id, content: "Arguments were not valid JSON." });
      continue;
    }
    last = callTool(store, "dream_submit", args);
    const text = last.content[0].text;
    log(`turn ${t}: ${last.isError ? "REJECTED" : "accepted"}: ${text.split("\n")[0].slice(0, 140)}`);
    if (!last.isError) return { ok: true, text, usage, turns: t, preparedChars: prepared.length };
    messages.push(msg, { role: "tool", tool_call_id: call.id, content: text });
  }
  return { ok: false, text: last?.content?.[0]?.text ?? "the model never called dream_submit", usage, turns, preparedChars: prepared.length };
}

export async function runAgentEval({ scenario, llm, qaModel, qa = false, log = console.log }) {
  const fx = loadFixtures(scenario);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "archivum-agent-eval-"));
  try {
    const store = new Store(root, fx.name);
    for (const [p, c] of Object.entries(fx.seedDocs)) store.writeDoc(p, c);
    const base = new Date("2026-11-01T00:00:00Z").getTime();
    fx.transcripts.forEach((t, i) => {
      const ts = new Date(base + i * 3_600_000).toISOString();
      const events = t.text.split(/\n\n(?=(?:USER|ASSISTANT|SYSTEM|TOOL [^\s:]+):\n)/).slice(1).map((blk) => {
        const m = /^(USER|ASSISTANT|SYSTEM|TOOL ([^\s:]+)):\n([\s\S]*)$/.exec(blk);
        return { role: m[1].startsWith("TOOL") ? "tool" : m[1].toLowerCase(), content: m[3], ...(m[2] ? { name: m[2] } : {}) };
      });
      store.saveTranscript({ id: t.id, source: t.source, events, status: "pending", created_at: ts, updated_at: ts });
    });
    const before = scoreDocs(fx.seedDocs, fx.expected);
    const run = await agentDream({ store, llm, log });
    const row = { scenario: fx.name, before: before.score, ok: run.ok, turns: run.turns, tokens: run.usage, preparedChars: run.preparedChars };
    if (!run.ok) return { ...row, after: null, error: run.text };
    const proposal = store.listProposals().at(-1);
    const applied = applyProposal(store, proposal);
    const finalDocs = store.wikiSnapshot();
    const after = scoreDocs(finalDocs, fx.expected);
    Object.assign(row, { after: after.score, passed: after.passed.length, total: after.total, failed: after.failed.map((f) => `${f.id}: ${f.detail}`), docs: Object.keys(finalDocs).sort(), skipped: applied.skipped.length });
    if (qa) {
      const usage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, total_tokens: 0 };
      const ask = makeAsk({ provider: "openai", apiKey: llm.apiKey, baseUrl: llm.baseUrl, model: qaModel ?? llm.model, usage });
      const contexts = makeContexts({ transcripts: fx.transcripts, seedDocs: fx.seedDocs, dreamedDocs: finalDocs, extraModes: fx.expected.extra_modes ?? [] });
      const modes = await runQaMatrix(fx.expected.questions, ask, contexts);
      row.qa = Object.fromEntries(Object.entries(modes).map(([m, r]) => [m, r.accuracy]));
      row.qaTable = renderQaTable(fx.expected.questions, modes);
    }
    return row;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values: v } = parseArgs({ options: { scenario: { type: "string", default: "quillon" }, "base-url": { type: "string" }, model: { type: "string" }, "qa-model": { type: "string" }, qa: { type: "boolean", default: false }, json: { type: "string" } } });
  const apiKey = process.env.OPENAI_API_KEY || process.env.ARCHIVUM_LLM_API_KEY;
  if (!v["base-url"] || !v.model || !apiKey) {
    console.error("usage: node eval/agent-dream.js --scenario NAME --base-url URL --model NAME [--qa] [--qa-model NAME]  (key in OPENAI_API_KEY or ARCHIVUM_LLM_API_KEY)");
    process.exit(2);
  }
  const names = v.scenario === "all" ? listScenarios().filter((n) => n !== "scale") : [v.scenario];
  const rows = [];
  for (const scenario of names) {
    console.log(`\n== ${scenario}`);
    rows.push(await runAgentEval({ scenario, llm: { baseUrl: v["base-url"], apiKey, model: v.model }, qaModel: v["qa-model"], qa: v.qa }));
    const r = rows.at(-1);
    console.log(r.ok ? `checks: ${(r.before * 100).toFixed(0)}% -> ${(r.after * 100).toFixed(0)}% (${r.passed}/${r.total}), ${r.turns} turn(s), tokens in/out ${r.tokens.prompt}/${r.tokens.completion}, prepared ${r.preparedChars} chars` : `FAILED: ${r.error}`);
    for (const f of r.failed ?? []) console.log(`  FAIL ${f}`);
    if (r.qaTable) console.log(r.qaTable);
  }
  if (v.json) fs.writeFileSync(v.json, JSON.stringify({ model: v.model, date: new Date().toISOString().slice(0, 10), rows }, null, 2));
}
