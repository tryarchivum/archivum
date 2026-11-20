import fs from "node:fs";
import readline from "node:readline";
import { MemoryWiki, scrubSecrets, sha256Hex, renderTranscript, renderNotes, runDream, estimateDream } from "./core.js";
import { UsageError } from "./errors.js";
import { intFlag } from "./args.js";
import { applyProposal, consumeInputs, proposalChanges, runRetention } from "./proposals.js";

export const MAX_TRANSCRIPTS = 50;
export const MAX_TRANSCRIPT_CHARS = 6_000_000;
export const MAX_NOTES = 300;
export const DEFAULT_BUDGET = 3_000_000;

const out = (s = "") => process.stdout.write(`${s}\n`);

/** LLM settings from the environment. Throws UsageError (exit 2) when something required is missing. */
export function resolveLlmConfig(env) {
  const provider = (env.ARCHIVUM_LLM_PROVIDER || "anthropic").toLowerCase();
  if (provider !== "anthropic" && provider !== "openai") {
    throw new UsageError(`ARCHIVUM_LLM_PROVIDER must be "anthropic" or "openai" (got "${provider}").`);
  }
  const apiKey = env.ARCHIVUM_LLM_API_KEY || (provider === "anthropic" ? env.ANTHROPIC_API_KEY : env.OPENAI_API_KEY);
  if (!apiKey) {
    throw new UsageError(
      `No API key for provider "${provider}". Set ARCHIVUM_LLM_API_KEY (or ${provider === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY"}).`,
    );
  }
  const llm = { provider, apiKey };
  if (env.ARCHIVUM_LLM_BASE_URL) llm.baseUrl = env.ARCHIVUM_LLM_BASE_URL;
  else if (provider === "openai") llm.baseUrl = "http://localhost:20128/v1";
  const fallbackModel = provider === "anthropic" ? "claude-haiku-5-5" : undefined;
  const analyzer = env.ARCHIVUM_ANALYZER_MODEL || fallbackModel;
  const organizer = env.ARCHIVUM_ORGANIZER_MODEL || fallbackModel;
  if (!analyzer || !organizer) {
    throw new UsageError(
      `Provider "openai" needs models: set ARCHIVUM_ANALYZER_MODEL and ARCHIVUM_ORGANIZER_MODEL to model names your endpoint serves.`,
    );
  }
  return { llm, models: { analyzer, organizer } };
}

/** Scrubs everything the dream agents write before it reaches the staging wiki. */
class ScrubbingDocs {
  constructor(wiki) {
    this.wiki = wiki;
    this.redactions = 0;
  }
  list(opts) {
    return this.wiki.list(opts);
  }
  get(p) {
    return this.wiki.get(p);
  }
  write(p, content, opts) {
    const r = scrubSecrets(content);
    this.redactions += r.count;
    return this.wiki.write(p, r.text, opts);
  }
  delete(p) {
    return this.wiki.delete(p);
  }
  rename(from, to) {
    return this.wiki.rename(from, to);
  }
}

/**
 * Parses --since. Accepts YYYY-MM-DD or a full ISO timestamp; returns epoch ms, or null when absent.
 * Throws UsageError (exit 2) on anything else.
 */
export function parseSince(raw) {
  if (raw === undefined) return null;
  const s = String(raw).trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/.exec(s);
  const ms = m ? Date.parse(m[0].replace(" ", "T")) : NaN;
  const dayOk = m ? new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).getUTCDate() === Number(m[3]) : false;
  if (!m || Number.isNaN(ms) || !dayOk) throw new UsageError(`--since must be an ISO date such as 2026-11-01 or 2026-11-01T08:00:00Z (got "${s}").`);
  return ms;
}

/**
 * Why a scheduled dream should not run now, or null when it is due.
 * Due = enough pending transcripts, the newest transcript is idle long enough, and the last dream is old enough.
 */
export function notDueReason(store, { minPending, idleMinutes, cooldownHours }, now, since = null) {
  const all = store.listTranscripts();
  const pending = all.filter((t) => t.status === "pending" && t.events.length > 0 && (since === null || Date.parse(t.updated_at) >= since));
  if (pending.length < minPending) return `${pending.length} pending transcript(s), need at least ${minPending}`;
  const newest = Math.max(...all.map((t) => Date.parse(t.updated_at)).filter((n) => !Number.isNaN(n)));
  if (Number.isFinite(newest)) {
    const idle = (now - newest) / 60_000;
    if (idle < idleMinutes) return `newest transcript changed ${Math.floor(idle)} minute(s) ago, wait until it is ${idleMinutes} minute(s) idle`;
  }
  const last = Math.max(...store.listProposals().map((p) => Date.parse(p.created_at)).filter((n) => !Number.isNaN(n)));
  if (Number.isFinite(last)) {
    const hours = (now - last) / 3_600_000;
    if (hours < cooldownHours) return `last dream was ${hours.toFixed(1)} hour(s) ago, cooldown is ${cooldownHours} hour(s)`;
  }
  return null;
}

export function selectInputs(store, { since = null, maxInputs = MAX_TRANSCRIPTS } = {}) {
  const pending = store
    .listTranscripts()
    .filter((t) => t.status === "pending" && t.events.length > 0 && (since === null || Date.parse(t.updated_at) >= since))
    .sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.id < b.id ? -1 : 1));
  const transcripts = [];
  let chars = 0;
  for (const t of pending) {
    if (transcripts.length >= maxInputs) break;
    const text = renderTranscript({ id: t.id, source: t.source, events: t.events });
    if (transcripts.length > 0 && chars + text.length > MAX_TRANSCRIPT_CHARS) break;
    chars += text.length;
    transcripts.push({ id: t.id, source: t.source, text, updated_at: t.updated_at });
  }
  const through = store.readState().notes_consolidated_through;
  const notes = store
    .readNotes()
    .filter((n) => !through || n.ts > through)
    .sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0))
    .slice(0, MAX_NOTES);
  return { transcripts, notes };
}

async function confirm(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await new Promise((resolve) => rl.question(question, resolve));
    return /^y(es)?$/i.test(String(answer).trim());
  } finally {
    rl.close();
  }
}

function progressPrinter() {
  let lastUsage = null;
  const print = (e) => {
    if (!e || typeof e !== "object") return;
    switch (e.type) {
      case "phase":
        out(`* ${e.message}`);
        break;
      case "analyzer_started":
      case "analyzer_done":
      case "organizer_started":
      case "organizer_done":
        out(`* [${e.agent}] ${e.message ?? e.type}`);
        break;
      case "agent_text":
        out(`  [${e.agent}] ${String(e.message ?? "").replace(/\s+/g, " ").slice(0, 160)}`);
        break;
      case "tool":
        out(`  [${e.agent}] ${e.tool}${e.path ? ` ${e.path}` : ""} ${e.ok ? "ok" : "FAILED"}${e.ok ? "" : e.message ? `: ${String(e.message).slice(0, 120)}` : ""}`);
        break;
      case "usage":
        lastUsage = e.usage;
        break;
      case "budget":
        out(`! ${e.message}`);
        break;
      case "error":
        out(`! error: ${e.message}`);
        break;
      default:
    }
  };
  return { print, usage: () => lastUsage };
}

export async function dreamCommand(store, flags, env) {
  const budget = intFlag(flags, "budget", { fallback: DEFAULT_BUDGET });
  const instructions = typeof flags.instructions === "string" && flags.instructions.trim() ? flags.instructions.trim() : null;
  const since = parseSince(flags.since);
  const maxInputs = intFlag(flags, "max-inputs", { min: 1, max: 200, fallback: MAX_TRANSCRIPTS });
  if (flags["if-due"]) {
    const opts = {
      minPending: intFlag(flags, "min-pending", { min: 1, fallback: 3 }),
      idleMinutes: intFlag(flags, "idle-minutes", { min: 0, fallback: 10 }),
      cooldownHours: intFlag(flags, "cooldown-hours", { min: 0, fallback: 6 }),
    };
    const reason = notDueReason(store, opts, Date.now(), since);
    if (reason) {
      out(`not due: ${reason}`);
      return 0;
    }
  } else {
    for (const f of ["min-pending", "idle-minutes", "cooldown-hours"]) {
      if (flags[f] !== undefined) throw new UsageError(`--${f} only applies together with --if-due.`);
    }
  }
  const { transcripts, notes } = selectInputs(store, { since, maxInputs });
  const inputs = transcripts.map((t) => ({ id: t.id, source: t.source, text: t.text }));
  if (notes.length > 0) inputs.push({ id: "notes", source: "notes", text: renderNotes(notes) });

  out(`Space: ${store.space}`);
  out(`Pending transcripts: ${transcripts.length}`);
  out(`Unconsolidated notes: ${notes.length}`);
  if (inputs.length === 0) {
    out("Nothing to dream about yet. Log a session or run `archivum remember \"...\"` first.");
    return 0;
  }
  const liveBefore = store.wikiSnapshot();
  const existingDocsBytes = Object.values(liveBefore).reduce((n, c) => n + Buffer.byteLength(c), 0);
  const est = estimateDream({ transcripts: inputs.map((i) => ({ chars: i.text.length })), existingDocsBytes });
  out(`Input size: ${est.chars.toLocaleString("en-US")} characters`);
  out(`Rough estimate: ~${est.est_total_tokens.toLocaleString("en-US")} tokens (budget ${budget.toLocaleString("en-US")}). This is billed by your LLM provider.`);
  for (const n of est.notes) out(`  ${n}`);
  if (flags["dry-run"]) {
    out("Dry run: nothing was sent.");
    return 0;
  }
  if (est.est_total_tokens > budget) {
    throw new UsageError(
      `The estimate (${est.est_total_tokens.toLocaleString("en-US")} tokens) is above the budget (${budget.toLocaleString("en-US")}). ` +
        "Dream less: pass --since DATE (only newer transcripts) or --max-inputs N (fewer transcripts), or allow more with a larger --budget TOKENS.",
    );
  }
  const config = resolveLlmConfig(env);
  if (!flags.yes) {
    if (!process.stdin.isTTY) throw new UsageError("Not a terminal: pass --yes to confirm that this dream may call your LLM provider.");
    if (!(await confirm("Proceed? [y/N] "))) {
      out("Canceled.");
      return 0;
    }
  }

  // Stage: clone live wiki into the proposal folder, run against a MemoryWiki loaded from it.
  const id = store.newProposalId();
  const base = Object.fromEntries(Object.entries(liveBefore).map(([p, c]) => [p, sha256Hex(c)]));
  store.writeBase(id, base);
  store.writeProposalWiki(id, liveBefore);
  const staging = new MemoryWiki(store.readProposalWiki(id));
  const docs = new ScrubbingDocs(staging);
  const notesThrough = notes.length ? notes[notes.length - 1].ts : null;
  const createdAt = new Date().toISOString();

  const ac = new AbortController();
  const onSigint = () => ac.abort();
  process.once("SIGINT", onSigint);
  const progress = progressPrinter();
  out(`Dreaming (proposal ${id}) ...`);
  let result;
  try {
    result = await runDream({
      llm: config.llm,
      models: config.models,
      docs,
      transcripts: inputs,
      instructions,
      budgetTokens: budget,
      signal: ac.signal,
      onEvent: progress.print,
    });
  } catch (e) {
    result = { status: "failed", summary: "", usage: progress.usage(), analyzed: [], organizer: { ok: false, changes: [] }, error: e?.message ?? String(e) };
  } finally {
    process.removeListener("SIGINT", onSigint);
  }

  const staged = staging.snapshot();
  store.writeProposalWiki(id, staged);
  const proposal = {
    id,
    status: "review",
    created_at: createdAt,
    dream_status: result.status,
    partial: false,
    summary: result.summary ?? "",
    error: result.error ?? null,
    usage: result.usage ?? null,
    analyzed: result.analyzed ?? [],
    organizer: result.organizer ?? null,
    models: config.models,
    provider: config.llm.provider,
    transcripts: transcripts.map((t) => t.id),
    transcript_versions: Object.fromEntries(transcripts.map((t) => [t.id, t.updated_at])),
    notes_through: notesThrough,
    redactions: docs.redactions,
  };
  const changes = proposalChanges(store, id);
  const complete = result.status === "completed" && result.organizer?.ok !== false && (result.analyzed ?? []).every((a) => a.ok !== false);
  proposal.partial = !complete && changes.length > 0;

  if (result.usage) {
    const u = result.usage;
    out(`Tokens used: ${Number(u.total_tokens ?? 0).toLocaleString("en-US")} (input ${u.input_tokens ?? 0}, output ${u.output_tokens ?? 0}, cache read ${u.cache_read_input_tokens ?? 0}, cache write ${u.cache_creation_input_tokens ?? 0})`);
  }
  if (result.summary) out(`Summary: ${String(result.summary).trim()}`);
  for (const c of result.organizer?.changes ?? []) out(`  - ${c}`);

  if (changes.length === 0) {
    if (complete) {
      proposal.status = "applied";
      proposal.no_changes = true;
      proposal.applied_at = new Date().toISOString();
      store.writeProposal(proposal);
      consumeInputs(store, proposal);
      out("The dream made no changes to the wiki; inputs are marked as dreamed.");
      runRetention(store);
      return 0;
    }
    fs.rmSync(store.proposalDir(id), { recursive: true, force: true });
    out(`The dream ended with status "${result.status}" and wrote nothing${result.error ? `: ${result.error}` : ""}. Inputs stay pending.`);
    return 1;
  }

  store.writeProposal(proposal);
  const counts = { added: 0, modified: 0, removed: 0 };
  for (const c of changes) counts[c.kind]++;
  out(`Proposal ${id} (${proposal.partial ? "review, PARTIAL" : "review"}): ${counts.added} added, ${counts.modified} modified, ${counts.removed} removed`);
  for (const c of changes) out(`  ${c.kind.padEnd(8)} ${c.path}`);
  if (docs.redactions > 0) out(`  (${docs.redactions} secret-like value(s) were redacted from the written documents)`);
  if (proposal.partial) {
    out(`WARNING: the dream did not finish cleanly (status ${result.status}${result.error ? `: ${result.error}` : ""}). Review the diff carefully; some inputs may not be covered and the index may be incomplete.`);
  }
  if (flags.apply && !proposal.partial) {
    const r = applyProposal(store, proposal);
    out(`Applied: ${r.applied.length} path(s) written${r.skipped.length ? `, ${r.skipped.length} skipped` : ""}.`);
    for (const s of r.skipped) out(`  skipped ${s.path}: ${s.reason}`);
    runRetention(store);
    return 0;
  }
  if (flags.apply) out("--apply was not honoured because the run was partial.");
  out("Next steps:");
  out(`  archivum diff ${id}      show what would change`);
  out(`  archivum apply ${id}     write it to the live wiki`);
  out(`  archivum reject ${id}    discard it`);
  runRetention(store);
  return complete ? 0 : 1;
}

