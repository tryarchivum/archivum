import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { sandbox, run, spaceDir, readJson, startFakeLlm, llmEnv, FAKE_SECRET } from "./helpers.js";

const events = (text) => [
  { role: "user", content: `${text}. Remember the test command.` },
  { role: "assistant", content: "Use npm test." },
];

async function seed(sb, id = "sess-1") {
  const r = await run(["log", "-", "--id", id, "--source", "t"], { env: sb.env, cwd: sb.work, input: JSON.stringify(events("Tests question")) });
  assert.equal(r.code, 0, r.stderr);
  const n = await run(["remember", "The staging port is 5433"], { env: sb.env, cwd: sb.work });
  assert.equal(n.code, 0);
}


const dir = (sb) => spaceDir(sb, "proj-x");
const proposals = (sb) => fs.readdirSync(path.join(dir(sb), "proposals"));

for (const kind of ["anthropic", "openai"]) {
  test(`dream -> diff -> apply happy path (${kind})`, async () => {
    const sb = sandbox();
    const fake = await startFakeLlm(kind);
    try {
      await seed(sb);
      const env = { ...sb.env, ...llmEnv(kind, fake) };
      const r = await run(["dream", "--yes"], { env, cwd: sb.work });
      assert.equal(r.code, 0, r.stdout + r.stderr);
      assert.match(r.stdout, /Pending transcripts: 1/);
      assert.match(r.stdout, /Unconsolidated notes: 1/);
      assert.match(r.stdout, /Rough estimate/);
      assert.match(r.stdout, /analyzer:sess-1/);
      assert.match(r.stdout, /write_doc \/fact-sess-1\.md ok/);
      assert.match(r.stdout, /archivum diff/);
      assert.match(r.stdout, /archivum apply/);
      assert.match(r.stdout, /archivum reject/);

      // provider plumbing
      assert.ok(fake.requests.length >= 6);
      const first = fake.requests[0];
      if (kind === "anthropic") {
        assert.equal(first.url, "/v1/messages");
        assert.equal(first.headers["x-api-key"], "test-key-anthropic");
      } else {
        assert.equal(first.url, "/v1/chat/completions");
        assert.equal(first.headers.authorization, "Bearer test-key-openai");
      }
      assert.ok(fake.requests.every((q) => q.body.model === "fake-analyzer" || q.body.model === "fake-organizer"));
      assert.ok(fake.requests.some((q) => q.body.model === "fake-organizer"));

      // nothing live yet; the proposal is staged
      assert.equal(fs.existsSync(path.join(dir(sb), "wiki")), false);
      const [id] = proposals(sb);
      const pdir = path.join(dir(sb), "proposals", id);
      const prop = readJson(path.join(pdir, "proposal.json"));
      assert.equal(prop.status, "review");
      assert.equal(prop.partial, false);
      assert.deepEqual(prop.transcripts, ["sess-1"]);
      assert.deepEqual(readJson(path.join(pdir, "base.json")), {});
      assert.ok(fs.existsSync(path.join(pdir, "wiki", "_index.md")));
      const stagedPage = fs.readFileSync(path.join(pdir, "wiki", "fact-sess-1.md"), "utf8");
      assert.ok(!stagedPage.includes(FAKE_SECRET));
      assert.match(stagedPage, /REDACTED/);

      let d = await run(["proposals"], { env, cwd: sb.work });
      assert.match(d.stdout, new RegExp(`${id}\\s+review`));
      d = await run(["diff"], { env, cwd: sb.work });
      assert.equal(d.code, 0);
      assert.match(d.stdout, /=== \/fact-sess-1\.md \(added\)/);
      assert.match(d.stdout, /^\+\+\+ proposed\/fact-sess-1\.md$/m);
      assert.match(d.stdout, /^\+Run tests with npm test\./m);
      assert.ok(!d.stdout.includes("\u001b["), "no colours");
      assert.ok(!d.stdout.includes(FAKE_SECRET));

      const a = await run(["apply"], { env, cwd: sb.work });
      assert.equal(a.code, 0, a.stderr);
      assert.match(a.stdout, /wrote \/_index\.md/);
      const live = fs.readFileSync(path.join(dir(sb), "wiki", "fact-sess-1.md"), "utf8");
      assert.equal(live, stagedPage);
      assert.ok(!live.includes(FAKE_SECRET));
      assert.equal(readJson(path.join(pdir, "proposal.json")).status, "applied");
      assert.equal(readJson(path.join(dir(sb), "transcripts", "sess-1.json")).status, "dreamed");
      assert.ok(readJson(path.join(dir(sb), "transcripts", "sess-1.json")).dreamed_at);
      const state = readJson(path.join(dir(sb), "state.json"));
      assert.ok(state.notes_consolidated_through);

      // history
      const log = fs.readFileSync(path.join(dir(sb), "history", "log.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
      assert.ok(log.length >= 2);
      for (const e of log) {
        assert.equal(e.operation, "create");
        assert.equal(e.actor, `dream:${id}`);
        assert.ok(fs.existsSync(path.join(dir(sb), "history", "files", e.file)));
        assert.match(e.file, /^\d+-[0-9a-f]{8}$/);
      }
      const h = await run(["history", "/_index.md"], { env, cwd: sb.work });
      assert.match(h.stdout, /v1\s+\S+\s+create\s+dream:/);

      // status + second apply refused
      const s = await run(["status"], { env, cwd: sb.work });
      assert.match(s.stdout, /Transcripts:\s+0 pending, 1 dreamed/);
      assert.match(s.stdout, /Wiki docs:\s+3/);
      const again = await run(["apply", id], { env, cwd: sb.work });
      assert.equal(again.code, 1);
      assert.match(again.stderr, /already applied/);

      // nothing left to dream: no LLM calls
      const count = fake.requests.length;
      const n = await run(["dream", "--yes"], { env, cwd: sb.work });
      assert.equal(n.code, 0);
      assert.match(n.stdout, /Nothing to dream/);
      assert.equal(fake.requests.length, count);

      // context now comes from the wiki index
      const c = await run(["context"], { env, cwd: sb.work });
      assert.match(c.stdout, /\[\[fact-sess-1\]\]/);
    } finally {
      await fake.close();
      sb.cleanup();
    }
  });
}

test("dream gating and configuration errors", async () => {
  const sb = sandbox();
  const fake = await startFakeLlm("anthropic");
  try {
    let r = await run(["dream"], { env: sb.env, cwd: sb.work });
    assert.equal(r.code, 0);
    assert.match(r.stdout, /Nothing to dream/);
    await seed(sb);

    // dry run: counts + estimate, no key needed
    r = await run(["dream", "--dry-run"], { env: sb.env, cwd: sb.work });
    assert.equal(r.code, 0);
    assert.match(r.stdout, /Pending transcripts: 1/);
    assert.match(r.stdout, /~[\d,]+ tokens/);
    assert.match(r.stdout, /Dry run/);

    // missing key -> 2
    r = await run(["dream", "--yes"], { env: sb.env, cwd: sb.work });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /ARCHIVUM_LLM_API_KEY/);

    // openai needs models -> 2
    r = await run(["dream", "--yes"], { env: { ...sb.env, ARCHIVUM_LLM_PROVIDER: "openai", ARCHIVUM_LLM_API_KEY: "k" }, cwd: sb.work });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /ARCHIVUM_ANALYZER_MODEL/);
    r = await run(["dream", "--yes"], { env: { ...sb.env, ARCHIVUM_LLM_PROVIDER: "nope", ARCHIVUM_LLM_API_KEY: "k" }, cwd: sb.work });
    assert.equal(r.code, 2);

    // no --yes and not a TTY -> 2, nothing sent
    const env = { ...sb.env, ...llmEnv("anthropic", fake) };
    r = await run(["dream"], { env, cwd: sb.work });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /--yes/);

    // estimate above budget -> 2
    r = await run(["dream", "--yes", "--budget", "1000"], { env, cwd: sb.work });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /above the budget/);
    r = await run(["dream", "--yes", "--budget", "lots"], { env, cwd: sb.work });
    assert.equal(r.code, 2);

    assert.equal(fake.requests.length, 0);
    assert.equal(fs.existsSync(path.join(dir(sb), "proposals")), false);

    // ANTHROPIC_API_KEY fallback and default model
    r = await run(["dream", "--yes"], { env: { ...sb.env, ANTHROPIC_API_KEY: "fallback-key", ARCHIVUM_LLM_BASE_URL: fake.baseUrl }, cwd: sb.work });
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.equal(fake.requests[0].headers["x-api-key"], "fallback-key");
    assert.equal(fake.requests[0].body.model, "claude-haiku-5-5");
  } finally {
    await fake.close();
    sb.cleanup();
  }
});

test("apply skips paths whose live file changed since the proposal; --force overrides", async () => {
  const sb = sandbox();
  const fake = await startFakeLlm("anthropic");
  try {
    await seed(sb);
    const env = { ...sb.env, ...llmEnv("anthropic", fake) };
    // first dream + apply creates /_index.md and a page
    assert.equal((await run(["dream", "--yes"], { env, cwd: sb.work })).code, 0);
    assert.equal((await run(["apply"], { env, cwd: sb.work })).code, 0);
    // second dream proposes changes against that live wiki
    await run(["log", "-", "--id", "sess-2"], { env, cwd: sb.work, input: JSON.stringify(events("Second")) });
    const r2 = await run(["dream", "--yes"], { env, cwd: sb.work });
    assert.equal(r2.code, 0, r2.stdout + r2.stderr);
    const ids = proposals(sb).sort();
    const id2 = ids.map((i) => readJson(path.join(dir(sb), "proposals", i, "proposal.json"))).find((p) => p.status === "review").id;
    const base = readJson(path.join(dir(sb), "proposals", id2, "base.json"));
    assert.ok(base["/_index.md"], "base holds live shas");

    // a human edits the index in the meantime
    const indexFile = path.join(dir(sb), "wiki", "_index.md");
    fs.writeFileSync(indexFile, "# My own index\n");
    const d = await run(["diff", id2], { env, cwd: sb.work });
    assert.match(d.stdout, /\/_index\.md.*live file changed/);

    const a = await run(["apply", id2], { env, cwd: sb.work });
    assert.equal(a.code, 0, a.stderr);
    assert.match(a.stdout, /skipped \/_index\.md/);
    assert.match(a.stdout, /wrote \/fact-sess-2\.md/);
    assert.equal(fs.readFileSync(indexFile, "utf8"), "# My own index\n");
    assert.ok(fs.existsSync(path.join(dir(sb), "wiki", "fact-sess-2.md")));
    assert.equal(readJson(path.join(dir(sb), "transcripts", "sess-2.json")).status, "dreamed");

    // the proposal-created version is in history
    const h = await run(["history", "/_index.md"], { env, cwd: sb.work });
    assert.match(h.stdout, /v1 .*create\s+dream:/);

    // dream again (new input), edit live again, apply all-skipped keeps review; --force writes
    await run(["log", "-", "--id", "sess-3"], { env, cwd: sb.work, input: JSON.stringify(events("Third")) });
    assert.equal((await run(["dream", "--yes"], { env, cwd: sb.work })).code, 0);
    const p3 = proposals(sb).map((i) => readJson(path.join(dir(sb), "proposals", i, "proposal.json"))).find((p) => p.status === "review");
    fs.writeFileSync(indexFile, "# Edited again\n");
    const staged = fs.readFileSync(path.join(dir(sb), "proposals", p3.id, "wiki", "_index.md"), "utf8");
    const f = await run(["apply", p3.id, "--force"], { env, cwd: sb.work });
    assert.equal(f.code, 0, f.stderr);
    assert.equal(fs.readFileSync(indexFile, "utf8"), staged);
  } finally {
    await fake.close();
    sb.cleanup();
  }
});

test("reject keeps live untouched and inputs pending; restore brings back old versions", async () => {
  const sb = sandbox();
  const fake = await startFakeLlm("openai");
  try {
    await seed(sb);
    const env = { ...sb.env, ...llmEnv("openai", fake) };
    assert.equal((await run(["dream", "--yes"], { env, cwd: sb.work })).code, 0);
    const rj = await run(["reject"], { env, cwd: sb.work });
    assert.equal(rj.code, 0, rj.stderr);
    assert.match(rj.stdout, /Rejected dream-/);
    assert.equal(fs.existsSync(path.join(dir(sb), "wiki")), false);
    assert.equal(readJson(path.join(dir(sb), "transcripts", "sess-1.json")).status, "pending");
    assert.equal((await run(["reject"], { env, cwd: sb.work })).code, 1, "rejecting twice: no review proposal left, picks rejected one");
    const list = await run(["proposals"], { env, cwd: sb.work });
    assert.match(list.stdout, /rejected/);

    // dream again, apply, then edit twice through apply of a later dream and restore
    assert.equal((await run(["dream", "--yes"], { env, cwd: sb.work })).code, 0);
    assert.equal((await run(["apply"], { env, cwd: sb.work })).code, 0);
    const page = path.join(dir(sb), "wiki", "fact-sess-1.md");
    const v1 = fs.readFileSync(page, "utf8");
    fs.writeFileSync(page, "human rewrite\n");
    let r = await run(["restore", "/fact-sess-1.md"], { env, cwd: sb.work });
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.equal(fs.readFileSync(page, "utf8"), v1);
    const h = await run(["history", "/fact-sess-1.md"], { env, cwd: sb.work });
    assert.match(h.stdout, /v1 .*create\s+dream:/);
    assert.match(h.stdout, /restore\s+restore/);
    r = await run(["restore", "/fact-sess-1.md", "--version", "1"], { env, cwd: sb.work });
    assert.equal(r.code, 1, "already matches version 1");
    r = await run(["restore", "/fact-sess-1.md", "--version", "99"], { env, cwd: sb.work });
    assert.equal(r.code, 1);
    r = await run(["restore", "/nothing.md"], { env, cwd: sb.work });
    assert.equal(r.code, 1);
    r = await run(["restore", "nothing"], { env, cwd: sb.work });
    assert.equal(r.code, 2);
    const all = await run(["history"], { env, cwd: sb.work });
    assert.match(all.stdout, /\/_index\.md v1/);
  } finally {
    await fake.close();
    sb.cleanup();
  }
});

test("organizer failure leaves a PARTIAL proposal in review; --apply is not honoured", async () => {
  const sb = sandbox();
  const fake = await startFakeLlm("anthropic", { failOrganizer: true });
  try {
    await seed(sb);
    const env = { ...sb.env, ...llmEnv("anthropic", fake) };
    const r = await run(["dream", "--yes", "--apply"], { env, cwd: sb.work });
    assert.equal(r.code, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /PARTIAL/);
    assert.match(r.stdout, /--apply was not honoured/);
    const [id] = proposals(sb);
    const prop = readJson(path.join(dir(sb), "proposals", id, "proposal.json"));
    assert.equal(prop.status, "review");
    assert.equal(prop.partial, true);
    assert.equal(fs.existsSync(path.join(dir(sb), "wiki")), false);
    assert.equal(readJson(path.join(dir(sb), "transcripts", "sess-1.json")).status, "pending");
    const l = await run(["proposals"], { env, cwd: sb.work });
    assert.match(l.stdout, /PARTIAL/);
    // the user can still review and apply it by hand
    const a = await run(["apply"], { env, cwd: sb.work });
    assert.equal(a.code, 0, a.stderr);
    assert.ok(fs.existsSync(path.join(dir(sb), "wiki", "fact-sess-1.md")));
  } finally {
    await fake.close();
    sb.cleanup();
  }
});

test("dream --apply applies right after a clean run; LLM auth failure writes nothing", async () => {
  const sb = sandbox();
  const fake = await startFakeLlm("openai");
  try {
    await seed(sb);
    const env = { ...sb.env, ...llmEnv("openai", fake) };
    const r = await run(["dream", "--yes", "--apply", "--instructions", "Track test commands"], { env, cwd: sb.work });
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /Applied: \d+ path\(s\) written/);
    assert.ok(fs.existsSync(path.join(dir(sb), "wiki", "_index.md")));
    assert.ok(fake.requests.some((q) => JSON.stringify(q.body).includes("Track test commands")));
    assert.equal(readJson(path.join(dir(sb), "transcripts", "sess-1.json")).status, "dreamed");
  } finally {
    await fake.close();
    sb.cleanup();
  }

  const sb2 = sandbox();
  const bad = await startFakeLlm("openai", { failAll: 401 });
  try {
    await seed(sb2);
    const env = { ...sb2.env, ...llmEnv("openai", bad) };
    const r = await run(["dream", "--yes"], { env, cwd: sb2.work });
    assert.equal(r.code, 1);
    assert.equal(fs.existsSync(path.join(dir(sb2), "wiki")), false);
    assert.equal(readJson(path.join(dir(sb2), "transcripts", "sess-1.json")).status, "pending");
    assert.deepEqual(fs.existsSync(path.join(dir(sb2), "proposals")) ? proposals(sb2) : [], []);
  } finally {
    await bad.close();
    sb2.cleanup();
  }
});

test("retention removes old dreamed transcripts only", async () => {
  const sb = sandbox();
  try {
    const tdir = path.join(dir(sb), "transcripts");
    fs.mkdirSync(tdir, { recursive: true });
    const day = 86_400_000;
    const mk = (id, status, ageDays) =>
      fs.writeFileSync(path.join(tdir, `${id}.json`), JSON.stringify({ id, source: "t", external_id: null, created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z", status, dreamed_at: status === "dreamed" ? new Date(Date.now() - ageDays * day).toISOString() : null, events: [{ role: "user", content: "x" }] }));
    mk("old", "dreamed", 40);
    mk("recent", "dreamed", 5);
    mk("pend", "pending", 0);
    let r = await run(["retention"], { env: sb.env, cwd: sb.work });
    assert.equal(r.code, 0);
    assert.match(r.stdout, /Removed 1 transcript/);
    assert.deepEqual(fs.readdirSync(tdir).sort(), ["pend.json", "recent.json"]);
    r = await run(["retention", "--days", "1"], { env: sb.env, cwd: sb.work });
    assert.match(r.stdout, /Removed 1 transcript/);
    assert.deepEqual(fs.readdirSync(tdir), ["pend.json"]);
    r = await run(["retention", "--days", "x"], { env: sb.env, cwd: sb.work });
    assert.equal(r.code, 2);
  } finally {
    sb.cleanup();
  }
});
