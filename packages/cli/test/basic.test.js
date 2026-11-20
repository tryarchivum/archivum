import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { sandbox, run, spaceDir, readJson, FAKE_SECRET } from "./helpers.js";

test("usage and exit codes", async () => {
  const sb = sandbox();
  try {
    let r = await run([], { env: sb.env });
    assert.equal(r.code, 2);
    assert.match(r.stdout, /Usage: archivum/);
    r = await run(["--help"], { env: sb.env });
    assert.equal(r.code, 0);
    r = await run(["--version"], { env: sb.env });
    assert.equal(r.code, 0);
    assert.match(r.stdout, /^\d+\.\d+\.\d+/);
    r = await run(["bogus"], { env: sb.env });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /Unknown command/);
    r = await run(["remember", "--nope", "x"], { env: sb.env });
    assert.equal(r.code, 2);
    r = await run(["recall"], { env: sb.env });
    assert.equal(r.code, 2);
    r = await run(["recall", "x", "--limit", "abc"], { env: sb.env });
    assert.equal(r.code, 2);
    r = await run(["apply"], { env: sb.env, cwd: sb.work });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /No proposals/);
  } finally {
    sb.cleanup();
  }
});

test("remember, recall, context, status use the cwd as space and scrub secrets", async () => {
  const sb = sandbox();
  try {
    let r = await run(["remember", "The deploy command is make release", `token ${FAKE_SECRET}`], { env: sb.env, cwd: sb.work });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /Saved note note_/);
    const dir = spaceDir(sb, "proj-x");
    const raw = fs.readFileSync(path.join(dir, "notes.jsonl"), "utf8");
    assert.ok(!raw.includes(FAKE_SECRET), "secret must not be stored");
    assert.match(raw, /REDACTED/);
    await run(["remember", "Postgres runs on port 5433 in staging"], { env: sb.env, cwd: sb.work });

    r = await run(["recall", "deploy command"], { env: sb.env, cwd: sb.work });
    assert.equal(r.code, 0);
    assert.match(r.stdout, /\[note\]/);
    assert.match(r.stdout, /make release/);
    r = await run(["recall", "postgres", "--limit", "1"], { env: sb.env, cwd: sb.work });
    assert.match(r.stdout, /5433/);
    assert.equal(r.stdout.split("[note]").length - 1, 1);

    r = await run(["context"], { env: sb.env, cwd: sb.work });
    assert.match(r.stdout, /Recent notes:/);
    r = await run(["context", "--max-chars", "100"], { env: sb.env, cwd: sb.work });
    assert.ok(r.stdout.length < 200);

    // another space is empty
    r = await run(["context", "--space", "other"], { env: sb.env, cwd: sb.work });
    assert.equal(r.stdout.trim(), "");
    r = await run(["status"], { env: { ...sb.env, ARCHIVUM_SPACE: "envspace" }, cwd: sb.work });
    assert.match(r.stdout, /Space:\s+envspace/);
    assert.match(r.stdout, /Notes:\s+0/);
    r = await run(["status"], { env: sb.env, cwd: sb.work });
    assert.match(r.stdout, /Space:\s+proj-x/);
    assert.match(r.stdout, /Notes:\s+2/);
    assert.match(r.stdout, /Transcripts:\s+0 pending, 0 dreamed/);
    assert.ok(r.stdout.includes(sb.archivumHome));
  } finally {
    sb.cleanup();
  }
});

test("space name is sanitized", async () => {
  const sb = sandbox();
  try {
    const r = await run(["remember", "hello", "--space", "my project/../x"], { env: sb.env });
    assert.equal(r.code, 0);
    assert.ok(fs.existsSync(path.join(spaceDir(sb, "my-project-..-x"), "notes.jsonl")));
  } finally {
    sb.cleanup();
  }
});

test("log stores a transcript from stdin and from a file, scrubbed", async () => {
  const sb = sandbox();
  try {
    const events = [
      { role: "user", content: `use key ${FAKE_SECRET} please` },
      { role: "assistant", content: "ok" },
      { role: "tool", name: "bash", content: "ran" },
    ];
    let r = await run(["log", "-", "--source", "aider", "--id", "sess-1"], { env: sb.env, cwd: sb.work, input: JSON.stringify({ events }) });
    assert.equal(r.code, 0, r.stderr);
    const f = path.join(spaceDir(sb, "proj-x"), "transcripts", "sess-1.json");
    const t = readJson(f);
    assert.equal(t.source, "aider");
    assert.equal(t.status, "pending");
    assert.equal(t.external_id, "sess-1");
    assert.equal(t.events.length, 3);
    assert.ok(!JSON.stringify(t).includes(FAKE_SECRET));

    const file = path.join(sb.root, "ev.json");
    fs.writeFileSync(file, JSON.stringify(events.slice(0, 2)));
    r = await run(["log", "--file", file], { env: sb.env, cwd: sb.work });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /Logged transcript trn_/);

    r = await run(["log", "-"], { env: sb.env, cwd: sb.work, input: "not json" });
    assert.equal(r.code, 2);
    r = await run(["log", "-"], { env: sb.env, cwd: sb.work, input: JSON.stringify([{ role: "robot", content: "x" }]) });
    assert.equal(r.code, 2);
    r = await run(["log", "-", "--id", "../evil"], { env: sb.env, cwd: sb.work, input: JSON.stringify(events) });
    assert.equal(r.code, 2);

    r = await run(["status"], { env: sb.env, cwd: sb.work });
    assert.match(r.stdout, /Transcripts:\s+2 pending/);
  } finally {
    sb.cleanup();
  }
});
