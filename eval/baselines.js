// QA baselines for the dreaming evaluation. Pure and deterministic: no network, no clock, no randomness.
//
// Four contexts answer the same questions (a fifth, notes-top-10, for scenarios that ask for it):
//   none          question only (what the model knows by itself)
//   notes         append-only notes: all transcript text cut into chunks, BM25 top-5 chunks per question
//   notes-top-10  the same notes, BM25 top-10 (does a bigger retrieval window close the gap?)
//   seed          the seed wiki: /_index.md plus the BM25 top-3 pages per question
//   dreamed       the dreamed wiki: same retrieval as `seed`
//
// Retrieval is core's own BM25 (buildCorpus / searchCorpus), so the wiki is navigated the way Archivum's `recall` does.
// Every mode is also measured on what it exposes: context size and stale exposure (see contextMetrics in this file).

import { buildCorpus, searchCorpus } from "../packages/core/src/index.js";
import { answerQuestions, contextStats, renderContext, summarizeStats } from "./score.js";

export const CONTEXT_MODES = ["none", "notes", "notes-top-10", "seed", "dreamed"];
/** The four modes every scenario has (notes-top-10 is opt-in). */
export const BASE_MODES = ["none", "notes", "seed", "dreamed"];
export const MODE_LABELS = {
  none: "no memory",
  notes: "append-only notes (BM25 top-5)",
  "notes-top-10": "append-only notes (BM25 top-10)",
  seed: "seed docs (index + top-3)",
  dreamed: "dreamed docs (index + top-3)",
};
export const NOTES_TOP_K = 5;
export const NOTES_WIDE_TOP_K = 10;
export const WIKI_TOP_K = 3;
export const CHUNK_CHARS = 700;
const INDEX_PATH = "/_index.md";

const SESSION_DATE = /Session date: (\d{4}-\d{2}-\d{2})/;

/** Splits text longer than `max` on line boundaries, then (for a single huge line) on characters. */
function splitLong(text, max) {
  if (text.length <= max) return [text];
  const out = [];
  let cur = "";
  for (const line of text.split("\n")) {
    const piece = cur ? `${cur}\n${line}` : line;
    if (piece.length <= max) {
      cur = piece;
      continue;
    }
    if (cur) out.push(cur);
    let rest = line;
    while (rest.length > max) {
      out.push(rest.slice(0, max));
      rest = rest.slice(max);
    }
    cur = rest;
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * All transcript text as append-only notes: paragraphs are packed greedily into chunks of at most `maxChars`
 * (a longer paragraph is split), each prefixed with the session date. No summarising, nothing dropped.
 * @param {{id:string, text:string}[]} transcripts
 * @returns {{id:string, ts:string, content:string}[]}
 */
export function chunkTranscripts(transcripts, { maxChars = CHUNK_CHARS } = {}) {
  const notes = [];
  for (const t of transcripts) {
    const body = t.text.replace(/\r\n/g, "\n").replace(/^TRANSCRIPT [^\n]*\n+/, "");
    const date = SESSION_DATE.exec(body)?.[1] ?? "undated";
    const budget = Math.max(50, maxChars - date.length - 3);
    const chunks = [];
    let cur = "";
    for (const para of body.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean).flatMap((p) => splitLong(p, budget))) {
      const next = cur ? `${cur}\n\n${para}` : para;
      if (next.length <= budget) {
        cur = next;
      } else {
        chunks.push(cur);
        cur = para;
      }
    }
    if (cur) chunks.push(cur);
    chunks.forEach((c, i) => notes.push({ id: `${t.id}#${String(i + 1).padStart(2, "0")}`, ts: date, content: `[${date}] ${c}` }));
  }
  return notes;
}

/** `(question) => context` over the notes; BM25 top-k chunks in score order. */
export function makeNotesRetriever(transcripts, { topK = NOTES_TOP_K, maxChars = CHUNK_CHARS } = {}) {
  const notes = chunkTranscripts(transcripts, { maxChars });
  const byId = new Map(notes.map((n) => [n.id, n]));
  const corpus = buildCorpus({ notes });
  return (question) =>
    searchCorpus(corpus, question, { topK })
      .map((h) => `=== note ${h.id} ===\n${byId.get(h.id).content}`)
      .join("\n\n");
}

/** `(question) => context` over a wiki: the index in full, then the BM25 top-k pages (the index is not a candidate page). */
export function makeWikiRetriever(docs, { topK = WIKI_TOP_K } = {}) {
  const snap = {};
  for (const [p, c] of Object.entries(docs instanceof Map ? Object.fromEntries(docs) : docs ?? {})) snap[p] = String(c ?? "").replace(/\r\n/g, "\n");
  const index = snap[INDEX_PATH];
  const pages = { ...snap };
  delete pages[INDEX_PATH];
  const corpus = buildCorpus({ wiki: pages });
  return (question) => {
    const chosen = {};
    if (index !== undefined) chosen[INDEX_PATH] = index;
    for (const h of searchCorpus(corpus, question, { topK })) chosen[h.id] = pages[h.id];
    return renderContext(chosen); // sorted by path: the same order for the same pages, whatever the scores
  };
}

/**
 * The context functions in display order. `dreamed` is null when no dream ran; `notes-top-10` exists only when a scenario
 * asks for it (`extraModes`, from expected.json).
 */
export function makeContexts({ transcripts, seedDocs, dreamedDocs = null, extraModes = [] }) {
  const contexts = { none: () => "", notes: makeNotesRetriever(transcripts) };
  if (extraModes.includes("notes-top-10")) contexts["notes-top-10"] = makeNotesRetriever(transcripts, { topK: NOTES_WIDE_TOP_K });
  contexts.seed = makeWikiRetriever(seedDocs);
  contexts.dreamed = dreamedDocs ? makeWikiRetriever(dreamedDocs) : null;
  return contexts;
}

/** Offline proxy, no LLM: does the retrieved context even contain text matching the question's answer regex? */
export function contextRecall(questions, contexts) {
  const out = {};
  for (const mode of CONTEXT_MODES) {
    const retrieve = contexts[mode];
    if (!retrieve || mode === "none") continue;
    const results = questions.map((q) => ({ id: q.id, ok: new RegExp(q.answer, (q.flags ?? "i").replace(/[gy]/g, "")).test(retrieve(q.question, q)) }));
    const hit = results.filter((r) => r.ok).length;
    out[mode] = { hit, total: results.length, rate: results.length ? hit / results.length : 0, results };
  }
  return out;
}

/**
 * Offline, no LLM: per retrieval mode the stale exposure (share of the questions that have a `reject` regex whose retrieved
 * context matches it, whatever a model would answer) and the mean context size in characters. Same shape as the QA modes.
 */
export function contextMetrics(questions, contexts) {
  const out = {};
  for (const mode of CONTEXT_MODES) {
    const retrieve = contexts[mode];
    if (!retrieve || mode === "none") continue;
    const results = questions.map((q) => ({ id: q.id, ...contextStats(q, retrieve(q.question, q)) }));
    out[mode] = { ...summarizeStats(results), results };
  }
  return out;
}

/** Runs every question under every available context (sequentially; errors from `ask` propagate). */
export async function runQaMatrix(questions, ask, contexts) {
  const modes = {};
  for (const mode of CONTEXT_MODES) {
    if (!contexts[mode]) continue;
    modes[mode] = await answerQuestions(questions, ask, contexts[mode]);
  }
  return modes;
}

const pct = (x) => `${(x * 100).toFixed(0)}%`;

/** Per-question table plus accuracy, stale-exposure and context-size rows. `modes` is the result of runQaMatrix. */
export function renderQaTable(questions, modes) {
  const present = CONTEXT_MODES.filter((m) => modes[m]);
  const labels = ["accuracy", "stale exposure", "mean ctx chars"];
  const width = Math.max(8, ...questions.map((q) => q.id.length), ...labels.map((l) => l.length));
  const col = (m) => Math.max(7, m.length);
  const head = `${"question".padEnd(width)}  ${present.map((m) => m.padEnd(col(m))).join("  ")}`;
  const lines = [head];
  for (const q of questions) {
    const cells = present.map((m) => (modes[m].results.find((r) => r.id === q.id)?.ok ? "ok" : "MISS").padEnd(col(m)));
    lines.push(`${q.id.padEnd(width)}  ${cells.join("  ")}`);
  }
  const row = (label, cell) => lines.push(`${label.padEnd(width)}  ${present.map((m) => String(cell(modes[m])).padEnd(col(m))).join("  ")}`);
  row("accuracy", (r) => `${r.correct}/${r.total}`);
  row("", (r) => pct(r.accuracy));
  row("stale exposure", (r) => (r.stale_total ? `${r.stale_exposed}/${r.stale_total}` : "-"));
  row("", (r) => (r.stale_exposure == null ? "" : pct(r.stale_exposure)));
  row("mean ctx chars", (r) => Math.round(r.mean_context_chars));
  return lines.join("\n");
}

/** Pads each cell to its header's width; one line per row. */
function renderColumns(headers, rows) {
  const lines = [headers.join("  ")];
  for (const r of rows) lines.push(r.map((cell, i) => (i === r.length - 1 ? String(cell) : String(cell).padEnd(headers[i].length))).join("  "));
  return lines.join("\n");
}

const SHORT = { none: "none", notes: "notes", "notes-top-10": "notes10", seed: "seed", dreamed: "dreamed" };
const f = (x) => (x == null ? "-" : pct(x));

/**
 * Cross-scenario summary table.
 * rows: {scenario, seedScore, afterScore|null, qa: {mode: accuracy}|null, recall: {mode: rate}|null}
 */
export function renderSummary(rows) {
  const width = Math.max(8, ...rows.map((r) => r.scenario.length));
  const qaModes = CONTEXT_MODES;
  const recallModes = CONTEXT_MODES.filter((m) => m !== "none");
  const headers = ["scenario".padEnd(width), "checks:seed", "checks:dreamed", ...qaModes.map((m) => `QA:${SHORT[m]}`), ...recallModes.map((m) => `recall:${SHORT[m]}`)];
  return renderColumns(
    headers,
    rows.map((r) => [r.scenario.padEnd(width), f(r.seedScore), f(r.afterScore), ...qaModes.map((m) => f(r.qa?.[m])), ...recallModes.map((m) => f(r.recall?.[m]))]),
  );
}

/**
 * Cross-scenario table of the context metrics (offline, no LLM): stale exposure and mean context size per mode.
 * rows: {scenario, stale: {mode: rate|null}, chars: {mode: mean}}
 */
export function renderMetricsSummary(rows) {
  const width = Math.max(8, ...rows.map((r) => r.scenario.length));
  const modes = CONTEXT_MODES.filter((m) => m !== "none");
  const headers = ["scenario".padEnd(width), ...modes.map((m) => `stale:${SHORT[m]}`), ...modes.map((m) => `chars:${SHORT[m]}`)];
  const chars = (x) => (x == null ? "-" : String(Math.round(x)));
  return renderColumns(headers, rows.map((r) => [r.scenario.padEnd(width), ...modes.map((m) => f(r.stale?.[m])), ...modes.map((m) => chars(r.chars?.[m]))]));
}

/** One scenario's offline context table: recall, stale exposure and mean size per retrieval mode (see contextMetrics). */
export function renderContextMetrics(recall, metrics) {
  const modes = CONTEXT_MODES.filter((m) => recall[m] && metrics[m]);
  const width = Math.max(...modes.map((m) => MODE_LABELS[m].length), 8);
  const lines = [`${"context (offline, no LLM)".padEnd(Math.max(width, 25))}  recall   stale exposure   mean chars`];
  for (const m of modes) {
    const stale = metrics[m].stale_total ? `${metrics[m].stale_exposed}/${metrics[m].stale_total} (${pct(metrics[m].stale_exposure)})` : "-";
    lines.push(`${MODE_LABELS[m].padEnd(Math.max(width, 25))}  ${`${recall[m].hit}/${recall[m].total}`.padEnd(7)}  ${stale.padEnd(14)}  ${Math.round(metrics[m].mean_context_chars)}`);
  }
  return lines.join("\n");
}
