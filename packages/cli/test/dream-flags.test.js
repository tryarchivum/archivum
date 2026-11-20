import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { sandbox, run, spaceDir, startFakeLlm, llmEnv } from "./helpers.js";

const dir = (sb) => spaceDir(sb, "proj-x");
const ago = (ms) => new Date(Date.now() - ms).toISOString();
const MIN = 60_000;
const HOUR = 3_600_000;

function writeTranscript(sb, id, updatedAt, extra = {}) {
  const d = path.join(dir(sb), "transcripts");
  fs.mkdirSync(d, { recursive: true });
  const t = {
    id,
    source: "t",
    created_at: updatedAt,
    updated_at: updatedAt,
    status: "pending",
    dreamed_at: null,
    events: [
      { role: "user", content: `Question ${id}. Remember the test command.` },
      { role: "assistant", content: "Use npm test." },
    ],
    ...extra,
  };
  fs.writeFileSync(path.join(d, `${id}.json`), JSON.stringify(t));
}

function writeProposal(sb, id, createdAt) {
  const d = path.join(dir(sb), "proposals", id);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, "proposal.json"), JSON.stringify({ id, status: "applied", created_at: createdAt }));
}

const proposalCount = (sb) => {
  try {
    return fs.readdirSync(path.join(dir(sb), "proposals")).length;
  } catch {
    return 0;
  }
};

test("dream --since only takes transcripts updated at or after DATE", async () => {
  const sb = sandbox();
  try {
    writeTranscript(sb, "old", "2026-01-01T00:00:00.000Z");
    writeTranscript(sb, "edge", "2026-06-01T00:00:00.000Z");
    writeTranscript(sb, "new", "2026-09-01T12:00:00.000Z");
    const r = await run(["dream", "--dry-run", "--since", "2026-06-01"], { env: sb.env, cwd: sb.work });
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /Pending transcripts: 2/);
    const all = await run(["dream", "--dry-run"], { env: sb.env, cwd: sb.work });
    assert.match(all.stdout, /Pending transcripts: 3/);
    const ts = await run(["dream", "--dry-run", "--since=2026-09-01T12:00:00Z"], { env: sb.env, cwd: sb.work });
    assert.match(ts.stdout, /Pending transcripts: 1/);
  } finally {
    sb.cleanup();
  }
});

test("dream --since rejects bad dates with exit 2", async () => {
  const sb = sandbox();
  try {
    for (const bad of ["yesterday", "2026-13-01", "2026-02-30", "11/01/2026", ""]) {
      const r = await run(["dream", "--dry-run", "--since", bad], { env: sb.env, cwd: sb.work });
      assert.equal(r.code, 2, `${bad}: ${r.stdout}${r.stderr}`);
      assert.match(r.stderr, /--since must be an ISO date/);
    }
  } finally {
    sb.cleanup();
  }
});

test("dream --max-inputs caps transcripts and validates 1..200", async () => {
  const sb = sandbox();
  try {
    for (const id of ["a", "b", "c", "d"]) writeTranscript(sb, id, ago(5 * HOUR));
    const r = await run(["dream", "--dry-run", "--max-inputs", "2"], { env: sb.env, cwd: sb.work });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /Pending transcripts: 2/);
    const full = await run(["dream", "--dry-run", "--max-inputs", "200"], { env: sb.env, cwd: sb.work });
    assert.match(full.stdout, /Pending transcripts: 4/);
    for (const bad of ["0", "201", "x", "-1"]) {
      const b = await run(["dream", "--dry-run", `--max-inputs=${bad}`], { env: sb.env, cwd: sb.work });
      assert.equal(b.code, 2, bad);
    }
  } finally {
    sb.cleanup();
  }
});

test("dream over budget suggests --since, --max-inputs and --budget (exit 2, nothing sent)", async () => {
  const sb = sandbox();
  const fake = await startFakeLlm("anthropic");
  try {
    writeTranscript(sb, "a", ago(5 * HOUR));
    const r = await run(["dream", "--yes", "--budget", "1"], { env: { ...sb.env, ...llmEnv("anthropic", fake) }, cwd: sb.work });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /above the budget/);
    assert.match(r.stderr, /--since/);
    assert.match(r.stderr, /--max-inputs/);
    assert.match(r.stderr, /--budget/);
    assert.equal(fake.requests.length, 0);
  } finally {
    await fake.close?.();
    sb.cleanup();
  }
});

test("--min-pending and friends need --if-due", async () => {
  const sb = sandbox();
  try {
    const r = await run(["dream", "--dry-run", "--min-pending", "2"], { env: sb.env, cwd: sb.work });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /--if-due/);
    const v = await run(["dream", "--if-due", "--min-pending", "0"], { env: sb.env, cwd: sb.work });
    assert.equal(v.code, 2);
  } finally {
    sb.cleanup();
  }
});

test("--if-due: not enough pending transcripts => 'not due', exit 0, nothing created", async () => {
  const sb = sandbox();
  try {
    writeTranscript(sb, "a", ago(5 * HOUR));
    writeTranscript(sb, "b", ago(5 * HOUR));
    const r = await run(["dream", "--if-due"], { env: sb.env, cwd: sb.work });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout.trim().split("\n").length, 1);
    assert.match(r.stdout, /^not due: 2 pending transcript\(s\), need at least 3/);
    assert.equal(proposalCount(sb), 0);
    const lower = await run(["dream", "--if-due", "--min-pending", "2"], { env: sb.env, cwd: sb.work });
    assert.equal(lower.code, 2, "due now: proceeds to the normal dream path (no API key in this env)");
    assert.match(lower.stderr, /No API key/);
  } finally {
    sb.cleanup();
  }
});

test("--if-due: newest transcript still active => not due; --idle-minutes tunes it", async () => {
  const sb = sandbox();
  try {
    writeTranscript(sb, "a", ago(5 * HOUR));
    writeTranscript(sb, "b", ago(5 * HOUR));
    writeTranscript(sb, "c", ago(2 * MIN));
    const r = await run(["dream", "--if-due"], { env: sb.env, cwd: sb.work });
    assert.equal(r.code, 0);
    assert.match(r.stdout, /^not due: newest transcript changed/);
    assert.equal(r.stdout.trim().split("\n").length, 1);
    const ok = await run(["dream", "--if-due", "--idle-minutes", "1"], { env: sb.env, cwd: sb.work });
    assert.equal(ok.code, 2, "due: proceeds to the normal dream path");
    assert.match(ok.stderr, /No API key/);
  } finally {
    sb.cleanup();
  }
});

test("--if-due: recent dream => cooldown; --cooldown-hours tunes it", async () => {
  const sb = sandbox();
  try {
    for (const id of ["a", "b", "c"]) writeTranscript(sb, id, ago(5 * HOUR));
    writeProposal(sb, "dream-old", ago(1 * HOUR));
    const r = await run(["dream", "--if-due"], { env: sb.env, cwd: sb.work });
    assert.equal(r.code, 0);
    assert.match(r.stdout, /^not due: last dream was 1\.0 hour\(s\) ago, cooldown is 6 hour\(s\)/);
    const ok = await run(["dream", "--if-due", "--cooldown-hours", "0"], { env: sb.env, cwd: sb.work });
    assert.equal(ok.code, 2);
    assert.match(ok.stderr, /No API key/);
  } finally {
    sb.cleanup();
  }
});

test("--if-due when due behaves like a normal dream: review-first, --yes required", async () => {
  const sb = sandbox();
  const fake = await startFakeLlm("anthropic");
  try {
    for (const id of ["a", "b", "c"]) writeTranscript(sb, id, ago(5 * HOUR));
    writeProposal(sb, "dream-old", ago(7 * HOUR));
    const env = { ...sb.env, ...llmEnv("anthropic", fake) };
    const noYes = await run(["dream", "--if-due"], { env, cwd: sb.work });
    assert.equal(noYes.code, 2);
    assert.match(noYes.stderr, /pass --yes/);
    assert.equal(fake.requests.length, 0);

    const r = await run(["dream", "--if-due", "--yes"], { env, cwd: sb.work });
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /Pending transcripts: 3/);
    assert.match(r.stdout, /archivum apply/);
    assert.ok(!/not due/.test(r.stdout));
    assert.equal(fs.existsSync(path.join(dir(sb), "wiki")), false, "never writes the live wiki");
    assert.equal(proposalCount(sb), 2);

    // The fresh proposal now puts the scheduler in cooldown.
    const again = await run(["dream", "--if-due", "--yes"], { env, cwd: sb.work });
    assert.equal(again.code, 0);
    assert.match(again.stdout, /^not due: last dream was/);
  } finally {
    await fake.close?.();
    sb.cleanup();
  }
});
