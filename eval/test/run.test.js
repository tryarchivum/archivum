import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import http from "node:http";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { addUsage, estimateDreamTokens, listScenarios, loadFixtures, makeAsk, parseTranscript, renderTable, snapshotDocs } from "../run.js";
import { scoreDocs } from "../score.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUN = path.join(HERE, "..", "run.js");
const RESULTS = path.join(HERE, "..", "results");

test("parseTranscript reads the header and counts events", () => {
  const t = parseTranscript("TRANSCRIPT trn_x source=cli events=3\n\nUSER:\nhi\n\nASSISTANT:\nUSER: not a label\n\nTOOL bash:\nout\n");
  assert.equal(t.id, "trn_x");
  assert.equal(t.source, "cli");
  assert.equal(t.declaredEvents, 3);
  assert.deepEqual(t.roles, ["USER", "ASSISTANT", "TOOL bash"]);
  assert.throws(() => parseTranscript("hello"), /header/);
});


test("makeAsk posts to the Messages API and accumulates usage (fake fetch)", async () => {
  const usage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, total_tokens: 0 };
  let req;
  const fetchImpl = async (url, init) => {
    req = { url, init, body: JSON.parse(init.body) };
    return new Response(JSON.stringify({ content: [{ type: "text", text: "make test" }], usage: { input_tokens: 10, output_tokens: 3 } }), { status: 200 });
  };
  const ask = makeAsk({ apiKey: "k", baseUrl: "http://x.test/", version: "2023-06-01", model: "m", usage, fetchImpl });
  assert.equal(await ask("How?", "CTX"), "make test");
  assert.equal(req.url, "http://x.test/v1/messages");
  assert.equal(req.init.headers["x-api-key"], "k");
  assert.equal(req.body.model, "m");
  assert.match(req.body.messages[0].content, /CTX[\s\S]*How\?/);
  assert.equal(usage.total_tokens, 13);
  const failing = makeAsk({ apiKey: "k", baseUrl: "http://x.test", version: "v", model: "m", usage, fetchImpl: async () => new Response("nope", { status: 500 }) });
  await assert.rejects(failing("q", "c"), /500/);
  const u = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, total_tokens: 0 };
  addUsage(u, { input_tokens: 1, cache_read_input_tokens: 2 });
  assert.equal(u.total_tokens, 3);
});

test("renderTable shows before and after columns", () => {
  const { seedDocs, expected } = loadFixtures();
  const before = scoreDocs(seedDocs, expected);
  const out = renderTable(expected, before, null);
  assert.match(out, /^check\s+before\s+after/);
  assert.match(out, /test-command-current\s+PASS\s+-/);
  assert.match(out, /flag-jobs\s+FAIL/);
});

function cli(args, env = {}) {
  const base = { ...process.env, ...env };
  if (!("ANTHROPIC_API_KEY" in env)) delete base.ANTHROPIC_API_KEY;
  return spawnSync(process.execPath, [RUN, ...args], { env: base, encoding: "utf8", timeout: 30_000 });
}

test("CLI without ANTHROPIC_API_KEY prints a skip notice and exits 0", () => {
  const r = cli([]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /skipped: no ANTHROPIC_API_KEY/);
});

test("CLI rejects unknown options and bad budget", () => {
  assert.equal(cli(["--nope"]).status, 2);
  assert.equal(cli(["--budget", "abc"], { ANTHROPIC_API_KEY: "x" }).status, 2);
  assert.equal(cli(["--help"]).status, 0);
});

function resultsCreatedBy(fn) {
  const before = existsSync(RESULTS) ? new Set(readdirSync(RESULTS)) : new Set();
  const out = fn();
  const created = readdirSync(RESULTS).filter((f) => !before.has(f));
  const files = created.map((f) => path.join(RESULTS, f));
  return { out, files, json: files.map((f) => JSON.parse(readFileSync(f, "utf8"))) };
}
const cleanup = (files) => files.forEach((f) => rmSync(f));

test("CLI --baseline scores the default scenario (quillon) offline and writes a results file", () => {
  const { out: r, files, json } = resultsCreatedBy(() => cli(["--baseline"]));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /=== scenario: quillon ===/);
  assert.match(r.stdout, /baseline score: \d+%/);
  assert.match(r.stdout, /test-command-current/);
  assert.match(r.stdout, /=== summary \(1 scenario\) ===/);
  assert.equal(files.length, 1);
  assert.equal(json[0].mode, "baseline");
  assert.deepEqual(Object.keys(json[0].scenarios), ["quillon"]);
  const q = json[0].scenarios.quillon;
  assert.ok(q.baseline.score > 0 && q.baseline.score < 1);
  assert.equal(q.fixtures.transcripts, loadFixtures().transcripts.length);
  assert.deepEqual(Object.keys(q.context_recall), ["notes", "seed"]);
  cleanup(files);
});

test("CLI --baseline --scenario all scores every scenario without a key and prints a summary table", () => {
  const { out: r, files, json } = resultsCreatedBy(() => cli(["--baseline", "--scenario", "all"]));
  assert.equal(r.status, 0, r.stderr);
  for (const name of listScenarios()) assert.match(r.stdout, new RegExp(`=== scenario: ${name} ===`));
  assert.match(r.stdout, /=== summary \(5 scenarios\) ===/);
  assert.match(r.stdout, /scenario\s+checks:seed\s+checks:dreamed\s+QA:none\s+QA:notes\s+QA:notes10\s+QA:seed\s+QA:dreamed\s+recall:notes\s+recall:notes10/);
  assert.match(r.stdout, /=== context metrics, offline[^\n]*\n\s*scenario\s+stale:notes\s+stale:notes10\s+stale:seed\s+stale:dreamed\s+chars:notes/);
  assert.match(r.stdout, /^drift\s+\d+%/m);
  assert.match(r.stdout, /^scale\s+\d+%/m);
  assert.equal(files.length, 1);
  assert.deepEqual(Object.keys(json[0].scenarios).sort(), [...listScenarios()].sort());
  assert.equal(json[0].summary.length, 5);
  for (const row of json[0].summary) assert.ok(row.seedScore >= 0 && row.seedScore < 1, row.scenario);
  for (const row of json[0].summary) assert.ok(row.stale && row.chars && row.recall, `${row.scenario}: metrics missing from the summary row`);
  assert.equal(json[0].scenarios.scale.context_metrics["notes-top-10"].results.length, 16);
  assert.equal(json[0].scenarios.drift.context_metrics["notes-top-10"], undefined, "notes-top-10 exists only for scale");
  cleanup(files);
});

test("CLI --scenario selects one scenario; unknown names exit 2 and list the available ones", () => {
  const { out: r, files } = resultsCreatedBy(() => cli(["--baseline", "--scenario", "injection"]));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /=== scenario: injection ===/);
  assert.match(r.stdout, /secret-deploy-key-absent\s+PASS/);
  assert.ok(!/scenario: quillon/.test(r.stdout));
  cleanup(files);
  const bad = cli(["--baseline", "--scenario", "nope"]);
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /unknown scenario "nope"; available: quillon, contradiction, drift, injection, scale/);
  assert.equal(cli(["--scenario", "../x", "--baseline"]).status, 2);
});

test("--baseline --qa without a key still skips (QA needs a model)", () => {
  assert.match(cli(["--baseline", "--qa", "--scenario", "drift"]).stdout, /skipped: no ANTHROPIC_API_KEY/);
});

test("--baseline --qa against a local fake OpenAI-compatible server prints and stores the four-context table", async () => {
  const seenContexts = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const user = JSON.parse(body).messages[1].content;
      seenContexts.push(user);
      const answer = /9443/.test(user.split("Question:")[0]) ? "9443" : "unknown";
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { content: answer } }], usage: { prompt_tokens: 10, completion_tokens: 1 } }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const before = new Set(readdirSync(RESULTS));
  try {
    const r = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [RUN, "--baseline", "--qa", "--scenario", "drift", "--provider", "openai", "--base-url", `http://127.0.0.1:${server.address().port}/v1`, "--model-analyzer", "a", "--model-organizer", "b"], {
        env: { ...process.env, OPENAI_API_KEY: "fake" },
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      child.on("error", reject);
      child.on("close", (status) => resolve({ status, stdout, stderr }));
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /question\s+none\s+notes\s+seed/);
    assert.match(r.stdout, /accuracy\s+0\/6/);
    assert.match(r.stdout, /q-port\s+MISS\s+ok\s+MISS/);
    const created = readdirSync(RESULTS).filter((f) => !before.has(f));
    assert.equal(created.length, 1);
    const json = JSON.parse(readFileSync(path.join(RESULTS, created[0]), "utf8"));
    const modes = json.scenarios.drift.qa.modes;
    assert.deepEqual(Object.keys(modes), ["none", "notes", "seed"]);
    assert.equal(modes.notes.results.find((x) => x.id === "q-port").ok, true);
    assert.equal(modes.none.results.find((x) => x.id === "q-port").ok, false);
    assert.equal(json.summary[0].qa.notes > 0, true);
    assert.equal(json.scenarios.drift.qa.usage.total_tokens, 11 * 18);
    assert.equal(seenContexts.length, 18); // 6 questions x 3 contexts (no dream in baseline mode)
    cleanup(created.map((f) => path.join(RESULTS, f)));
  } finally {
    server.close();
  }
});

test("snapshotDocs reads every document of a DocsApi", () => {
  const docs = { list: () => [{ path: "/a.md" }, { path: "/b.md" }], get: (p) => ({ path: p, content: `c${p}` }) };
  assert.deepEqual(snapshotDocs(docs), { "/a.md": "c/a.md", "/b.md": "c/b.md" });
});

test("makeAsk (openai) posts to /chat/completions and accumulates usage", async () => {
  const usage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, total_tokens: 0 };
  let req;
  const fetchImpl = async (url, init) => {
    req = { url, init, body: JSON.parse(init.body) };
    return new Response(JSON.stringify({ choices: [{ message: { content: "make test" } }], usage: { prompt_tokens: 12, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 2 } } }), { status: 200 });
  };
  const ask = makeAsk({ provider: "openai", apiKey: "k", baseUrl: "http://x.test/v1/", model: "gpt-x", usage, fetchImpl });
  assert.equal(await ask("How?", "CTX"), "make test");
  assert.equal(req.url, "http://x.test/v1/chat/completions");
  assert.equal(req.init.headers.authorization, "Bearer k");
  assert.equal(req.body.messages[0].role, "system");
  assert.match(req.body.messages[1].content, /CTX[\s\S]*How\?/);
  assert.equal(usage.total_tokens, 15);
  assert.equal(usage.cache_read_input_tokens, 2);
});

test("CLI --provider openai requires models, then skips without a key", () => {
  assert.equal(cli(["--provider", "openai"]).status, 2);
  const r = cli(["--provider", "openai", "--model-analyzer", "a", "--model-organizer", "b"], { OPENAI_API_KEY: "", ARCHIVUM_LLM_API_KEY: "" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /skipped: no OPENAI_API_KEY/);
  assert.equal(cli(["--provider", "bogus"]).status, 2);
});

// ---------------------------------------------------------------- scale: dream-cost gate and the five-mode QA run

test("the dream estimate of scale is about a million tokens and printed before running; --baseline needs no budget", () => {
  const estimate = estimateDreamTokens(loadFixtures("scale"));
  assert.ok(estimate >= 600_000 && estimate <= 3_000_000, `estimate ${estimate}`);
  assert.ok(estimate > estimateDreamTokens(loadFixtures("quillon")), "scale costs more than a small scenario");
  for (const name of ["quillon", "drift", "contradiction", "injection"]) {
    assert.ok(estimateDreamTokens(loadFixtures(name)) < 1_500_000, name);
    assert.equal(loadFixtures(name).expected.dream_cost_gate, undefined, `${name} is not gated`);
  }
  const { out: r, files } = resultsCreatedBy(() => cli(["--baseline", "--scenario", "scale"]));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`estimated dream cost \\(rough, can be off by 2x\\): about ${estimate.toLocaleString("en-US")} tokens for 48 transcripts; not run in --baseline mode`));
  assert.match(r.stdout, /port-current\s+FAIL/);
  assert.match(r.stdout, /append-only notes \(BM25 top-10\)/);
  cleanup(files);
});

test("--scenario scale skips with a clear message unless --budget covers the estimate (no network is touched)", () => {
  const estimate = estimateDreamTokens(loadFixtures("scale"));
  for (const budgetArgs of [["--budget", "300000"], ["--budget", String(estimate - 1)]]) {
    // an unreachable base URL: if the gate failed, the dream would try to connect and fail loudly
    const { out: r, files, json } = resultsCreatedBy(() => cli(["--scenario", "scale", "--base-url", "http://127.0.0.1:9", ...budgetArgs], { ANTHROPIC_API_KEY: "fake-key-for-test" }));
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /estimated dream cost \(rough, can be off by 2x\): about [\d,]+ tokens for 48 transcripts; --budget is [\d,]+/);
    assert.match(r.stdout, new RegExp(`skipped: scale would need about ${estimate.toLocaleString("en-US")} tokens for the dream alone and --budget is [\\d,]+; rerun with --budget ${estimate} or more`));
    assert.ok(!/dream: 48 transcripts/.test(r.stdout), "no dream may start");
    assert.match(r.stdout, /no scenario ran/);
    assert.equal(files.length, 1);
    assert.equal(json[0].scenarios.scale.skipped.startsWith("skipped: scale"), true);
    assert.equal(json[0].scenarios.scale.estimate_tokens, estimate);
    assert.deepEqual(json[0].summary, []);
    cleanup(files);
  }
});

test("--baseline --qa on scale asks five contexts' worth of questions and reports accuracy, stale exposure and context size", async () => {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const user = JSON.parse(body).messages[1].content;
      seen.push(user);
      // a model that answers the staging-cluster question when the notes contain it and says unknown otherwise
      const answer = /cormorant-stg-2/.test(user.split("Question:")[0]) ? "cormorant-stg-2" : "unknown";
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { content: answer } }], usage: { prompt_tokens: 10, completion_tokens: 1 } }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const before = new Set(readdirSync(RESULTS));
  try {
    const r = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [RUN, "--baseline", "--qa", "--scenario", "scale", "--provider", "openai", "--base-url", `http://127.0.0.1:${server.address().port}/v1`, "--model-analyzer", "a", "--model-organizer", "b"], {
        env: { ...process.env, OPENAI_API_KEY: "fake" },
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      child.on("error", reject);
      child.on("close", (status) => resolve({ status, stdout, stderr }));
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /question\s+none\s+notes\s+notes-top-10\s+seed/);
    assert.match(r.stdout, /accuracy\s+0\/16\s+\d+\/16\s+\d+\/16\s+0\/16/);
    assert.match(r.stdout, /stale exposure\s+0\/13\s+\d+\/13/);
    assert.match(r.stdout, /mean ctx chars\s+0\s+\d+/);
    assert.equal(seen.length, 16 * 4, "16 questions x (none, notes, notes-top-10, seed)");
    const created = readdirSync(RESULTS).filter((f) => !before.has(f));
    assert.equal(created.length, 1);
    const json = JSON.parse(readFileSync(path.join(RESULTS, created[0]), "utf8"));
    const modes = json.scenarios.scale.qa.modes;
    assert.deepEqual(Object.keys(modes), ["none", "notes", "notes-top-10", "seed"]);
    assert.equal(modes.none.stale_exposed, 0);
    assert.equal(modes.none.mean_context_chars, 0);
    assert.ok(modes["notes-top-10"].mean_context_chars > modes.notes.mean_context_chars);
    assert.ok(modes.notes.stale_exposed >= 1);
    // the QA numbers and the offline numbers are computed from the same contexts
    const offline = json.scenarios.scale.context_metrics;
    for (const m of ["notes", "notes-top-10", "seed"]) {
      assert.equal(modes[m].stale_exposed, offline[m].stale_exposed, m);
      assert.equal(modes[m].mean_context_chars, offline[m].mean_context_chars, m);
    }
    assert.equal(modes.seed.results.find((x) => x.id === "q-cluster").ok, false);
    assert.equal(json.summary[0].qa["notes-top-10"] >= json.summary[0].qa.notes, true);
    assert.equal(json.summary[0].stale["notes-top-10"], offline["notes-top-10"].stale_exposure);
    cleanup(created.map((f) => path.join(RESULTS, f)));
  } finally {
    server.close();
  }
});
