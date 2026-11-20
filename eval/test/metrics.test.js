// The QA-phase metrics added for every scenario: accuracy, stale exposure and mean context size per context mode.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BASE_MODES, CONTEXT_MODES, contextMetrics, makeContexts, renderContextMetrics, renderMetricsSummary, renderQaTable, renderSummary, runQaMatrix,
} from "../baselines.js";
import { loadFixtures } from "../run.js";
import { answerQuestions, contextStats, summarizeStats, validateExpected } from "../score.js";
import { SCENARIO_DOCS } from "./helpers.js";

const scale = loadFixtures("scale");
const drift = loadFixtures("drift");

test("contextStats: size in characters; stale only when the question has a reject regex and the context matches it", () => {
  const q = { answer: "9443", reject: "\\b(9100|9115)\\b" };
  assert.deepEqual(contextStats(q, "listens on 9100 (old) and 9443"), { chars: 30, stale: true });
  assert.deepEqual(contextStats(q, "listens on 9443"), { chars: 15, stale: false });
  assert.deepEqual(contextStats(q, ""), { chars: 0, stale: false });
  assert.deepEqual(contextStats(q, undefined), { chars: 0, stale: false });
  assert.deepEqual(contextStats({ answer: "x" }, "anything 9100"), { chars: 13, stale: null });
  assert.equal(contextStats({ answer: "x", reject: "SECRET" }, "a secret").stale, true, "case-insensitive like the other regexes");
  assert.equal(contextStats({ answer: "x", reject: "SECRET", flags: "" }, "a secret").stale, false, "flags are honoured");
});

test("summarizeStats: stale rate over the questions that have a reject, mean size over all questions", () => {
  const s = summarizeStats([
    { chars: 100, stale: true },
    { chars: 200, stale: false },
    { chars: 300, stale: null },
    { chars: 400, stale: true },
  ]);
  assert.deepEqual(s, { stale_exposed: 2, stale_total: 3, stale_exposure: 2 / 3, mean_context_chars: 250 });
  assert.deepEqual(summarizeStats([{ chars: 10, stale: null }]), { stale_exposed: 0, stale_total: 0, stale_exposure: null, mean_context_chars: 10 });
  assert.deepEqual(summarizeStats([]), { stale_exposed: 0, stale_total: 0, stale_exposure: null, mean_context_chars: 0 });
});

test("answerQuestions: stale exposure counts the context, not the answer; a correct answer can still have been exposed", async () => {
  const questions = [
    { id: "a", question: "port?", answer: "8443", reject: "7411" },
    { id: "b", question: "log?", answer: "jsonl", reject: "journald" },
    { id: "c", question: "cluster?", answer: "cormorant" },
  ];
  const contexts = { "port?": "port was 7411 until 2026-01-27, now 8443", "log?": "logs go to harbor.jsonl", "cluster?": "cormorant-stg-2" };
  const answers = { "port?": "8443", "log?": "harbor.jsonl", "cluster?": "unknown" };
  const r = await answerQuestions(questions, (q) => answers[q], (q) => contexts[q]);
  assert.deepEqual(r.results.map((x) => [x.id, x.ok, x.stale, x.context_chars]), [["a", true, true, 40], ["b", true, false, 23], ["c", false, null, 15]]);
  assert.equal(r.correct, 2);
  assert.equal(r.stale_exposed, 1);
  assert.equal(r.stale_total, 2);
  assert.equal(r.stale_exposure, 0.5);
  assert.equal(r.mean_context_chars, (40 + 23 + 15) / 3);
  // a fixed context string is measured the same way
  const fixed = await answerQuestions(questions.slice(0, 1), () => "8443", "7411");
  assert.equal(fixed.stale_exposure, 1);
  assert.equal(fixed.accuracy, 1);
});

test("makeContexts adds notes-top-10 only on request, between notes and seed", () => {
  const plain = makeContexts({ transcripts: scale.transcripts, seedDocs: scale.seedDocs });
  assert.deepEqual(Object.keys(plain), BASE_MODES);
  const wide = makeContexts({ transcripts: scale.transcripts, seedDocs: scale.seedDocs, dreamedDocs: SCENARIO_DOCS.scale.good, extraModes: scale.expected.extra_modes });
  assert.deepEqual(Object.keys(wide), CONTEXT_MODES);
  assert.deepEqual(CONTEXT_MODES, ["none", "notes", "notes-top-10", "seed", "dreamed"]);
  const q = "Which TCP port does the harbor control API listen on now?";
  const sections = (ctx) => ctx.split("\n\n=== note ").length;
  assert.ok(sections(wide.notes(q)) <= 5);
  assert.ok(sections(wide["notes-top-10"](q)) > 5 && sections(wide["notes-top-10"](q)) <= 10);
  // the top-5 are the first five of the top-10 (same ranking, bigger window)
  assert.ok(wide["notes-top-10"](q).startsWith(wide.notes(q)));
});

test("contextMetrics: per retrieval mode, deterministic, no 'none', consistent with the QA matrix", async () => {
  const contexts = makeContexts({ transcripts: scale.transcripts, seedDocs: scale.seedDocs, dreamedDocs: SCENARIO_DOCS.scale.good, extraModes: ["notes-top-10"] });
  const m = contextMetrics(scale.expected.questions, contexts);
  assert.deepEqual(Object.keys(m), ["notes", "notes-top-10", "seed", "dreamed"]);
  assert.deepEqual(m, contextMetrics(scale.expected.questions, contexts));
  for (const mode of Object.keys(m)) {
    assert.equal(m[mode].results.length, 16);
    assert.equal(m[mode].stale_total, 13, "13 of the 16 questions carry a reject regex");
    assert.ok(m[mode].stale_exposed >= 0 && m[mode].stale_exposed <= 13);
    assert.ok(m[mode].mean_context_chars > 0);
  }
  // a bigger window can only add text: more characters, never less stale exposure
  assert.ok(m["notes-top-10"].mean_context_chars > m.notes.mean_context_chars);
  assert.ok(m["notes-top-10"].stale_exposed >= m.notes.stale_exposed);
  // the seed wiki states the first values, which are exactly what the reject regexes name
  assert.equal(m.seed.stale_exposed, 13);
  // the hand-built good wiki keeps superseded values only in a dated history page, which retrieval may or may not pull in
  const matrix = await runQaMatrix(scale.expected.questions, () => "unknown", contexts);
  for (const mode of ["none", "notes", "notes-top-10", "seed", "dreamed"]) assert.ok(matrix[mode], mode);
  for (const mode of Object.keys(m)) {
    assert.equal(matrix[mode].stale_exposed, m[mode].stale_exposed, mode);
    assert.equal(matrix[mode].mean_context_chars, m[mode].mean_context_chars, mode);
  }
  assert.equal(matrix.none.stale_exposed, 0);
  assert.equal(matrix.none.stale_total, 13);
  assert.equal(matrix.none.mean_context_chars, 0);
});

test("stale exposure on a scenario with explicit rejects: drift port question", () => {
  const contexts = makeContexts({ transcripts: drift.transcripts, seedDocs: drift.seedDocs });
  const m = contextMetrics(drift.expected.questions, contexts);
  assert.deepEqual(Object.keys(m), ["notes", "seed"]);
  const port = m.notes.results.find((r) => r.id === "q-port");
  assert.equal(typeof port.stale, "boolean");
  assert.ok(m.seed.stale_exposed >= 1, "the drift seed wiki states 9100, which q-port rejects");
});

test("renderQaTable shows accuracy, stale exposure and mean context size for every mode, notes-top-10 included", () => {
  const questions = [
    { id: "q1", question: "a?", answer: "1", reject: "0" },
    { id: "q2", question: "b?", answer: "2" },
  ];
  const modes = {
    none: { correct: 0, total: 2, accuracy: 0, stale_exposed: 0, stale_total: 1, stale_exposure: 0, mean_context_chars: 0, results: [{ id: "q1", ok: false }, { id: "q2", ok: false }] },
    "notes-top-10": { correct: 2, total: 2, accuracy: 1, stale_exposed: 1, stale_total: 1, stale_exposure: 1, mean_context_chars: 6244.4, results: [{ id: "q1", ok: true }, { id: "q2", ok: true }] },
  };
  const out = renderQaTable(questions, modes);
  const lines = out.split("\n");
  assert.match(lines[0], /^question\s+none\s+notes-top-10$/);
  assert.match(out, /^q1\s+MISS\s+ok\s*$/m);
  assert.match(out, /^accuracy\s+0\/2\s+2\/2\s*$/m);
  assert.match(out, /^\s+0%\s+100%\s*$/m);
  assert.match(out, /^stale exposure\s+0\/1\s+1\/1\s*$/m);
  assert.match(out, /^\s+0%\s+100%\s*$/m);
  assert.match(out, /^mean ctx chars\s+0\s+6244\s*$/m);
  const noReject = renderQaTable([questions[1]], { none: { ...modes.none, stale_total: 0, stale_exposure: null } });
  assert.match(noReject, /^stale exposure\s+-\s*$/m);
});

test("summary tables: QA, recall, stale exposure and context size per scenario; missing values are dashes", () => {
  const rows = [
    {
      scenario: "scale", seedScore: 0.2083, afterScore: null,
      qa: { none: 0, notes: 0.5, "notes-top-10": 0.75, seed: 0 },
      recall: { notes: 0.5, "notes-top-10": 0.6875, seed: 0 },
      stale: { notes: 0.846, "notes-top-10": 1, seed: 1 },
      chars: { notes: 3130.2, "notes-top-10": 6244.7, seed: 1410 },
    },
    { scenario: "drift", seedScore: 0.4, afterScore: 1, qa: null, recall: { notes: 1, seed: 0.5 }, stale: { notes: 0.25, seed: null }, chars: { notes: 2000, seed: 900 } },
  ];
  const summary = renderSummary(rows).split("\n");
  assert.match(summary[0], /^scenario\s+checks:seed\s+checks:dreamed\s+QA:none\s+QA:notes\s+QA:notes10\s+QA:seed\s+QA:dreamed\s+recall:notes\s+recall:notes10\s+recall:seed\s+recall:dreamed$/);
  assert.match(summary[1], /^scale\s+21%\s+-\s+0%\s+50%\s+75%\s+0%\s+-\s+50%\s+69%\s+0%\s+-$/);
  assert.match(summary[2], /^drift\s+40%\s+100%\s+-\s+-\s+-\s+-\s+-\s+100%\s+-\s+50%\s+-$/);
  const metrics = renderMetricsSummary(rows).split("\n");
  assert.match(metrics[0], /^scenario\s+stale:notes\s+stale:notes10\s+stale:seed\s+stale:dreamed\s+chars:notes\s+chars:notes10\s+chars:seed\s+chars:dreamed$/);
  assert.match(metrics[1], /^scale\s+85%\s+100%\s+100%\s+-\s+3130\s+6245\s+1410\s+-$/);
  assert.match(metrics[2], /^drift\s+25%\s+-\s+-\s+-\s+2000\s+-\s+900\s+-$/);
});

test("renderContextMetrics lists recall, stale exposure and size for each offline mode", () => {
  const contexts = makeContexts({ transcripts: scale.transcripts, seedDocs: scale.seedDocs, extraModes: ["notes-top-10"] });
  const recall = Object.fromEntries(Object.keys(contexts).filter((m) => contexts[m] && m !== "none").map((m) => [m, { hit: 1, total: 2 }]));
  const metrics = contextMetrics(scale.expected.questions, contexts);
  const out = renderContextMetrics(recall, metrics);
  assert.match(out, /^context \(offline, no LLM\)\s+recall\s+stale exposure\s+mean chars$/m);
  assert.match(out, /^append-only notes \(BM25 top-5\)\s+1\/2\s+\d+\/13 \(\d+%\)\s+\d+$/m);
  assert.match(out, /^append-only notes \(BM25 top-10\)\s+1\/2\s+\d+\/13 \(\d+%\)\s+\d+$/m);
  assert.match(out, /^seed docs \(index \+ top-3\)\s+1\/2\s+13\/13 \(100%\)\s+\d+$/m);
});

test("validateExpected checks the new optional fields", () => {
  const base = { checks: [{ id: "a", description: "d", type: "doc_count", min: 1 }], questions: [] };
  assert.deepEqual(validateExpected({ ...base, extra_modes: ["notes-top-10"], dream_cost_gate: true }), []);
  assert.ok(validateExpected({ ...base, extra_modes: ["notes-top-99"] }).some((e) => /extra_modes/.test(e)));
  assert.ok(validateExpected({ ...base, extra_modes: "notes-top-10" }).some((e) => /extra_modes/.test(e)));
  assert.ok(validateExpected({ ...base, dream_cost_gate: "yes" }).some((e) => /dream_cost_gate/.test(e)));
});
