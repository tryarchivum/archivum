import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { FAKE_SECRET, run, sandbox, spaceDir, readJson } from "./helpers.js";

const j = (o) => JSON.stringify(o);

function session({ id, cwd, extra = [] }) {
  return [
    j({ type: "title", v: 1, title: "A session" }),
    j({ type: "session", version: 3, id, timestamp: "2026-11-14T02:40:56.842Z", cwd }),
    j({ type: "message", timestamp: "2026-11-14T02:41:00.000Z", message: { role: "user", content: [{ type: "text", text: `my key is ${FAKE_SECRET}, how do I run tests?` }] } }),
    j({ type: "message", timestamp: "2026-11-14T02:41:05.000Z", message: { role: "assistant", content: [{ type: "text", text: "Run make test." }, { type: "toolCall", id: "c1", name: "bash", arguments: { command: "make test" } }] } }),
    j({ type: "message", timestamp: "2026-11-14T02:41:09.000Z", message: { role: "toolResult", toolCallId: "c1", toolName: "bash", content: [{ type: "text", text: "12 passed" }], isError: false } }),
    ...extra,
  ].join("\n");
}

test("imports omp sessions for the current directory, scrubbed and idempotent", async () => {
  const sb = sandbox();
  try {
    const sessions = path.join(sb.root, "omp-sessions");
    fs.mkdirSync(path.join(sessions, "-proj-x"), { recursive: true });
    fs.mkdirSync(path.join(sessions, "-other"), { recursive: true });
    fs.writeFileSync(path.join(sessions, "-proj-x", "a.jsonl"), session({ id: "sess-a", cwd: sb.work }));
    fs.writeFileSync(path.join(sessions, "-other", "b.jsonl"), session({ id: "sess-b", cwd: path.join(sb.root, "elsewhere") }));
    fs.writeFileSync(path.join(sessions, "-other", "empty.jsonl"), j({ type: "session", id: "sess-c", cwd: sb.work }));
    fs.writeFileSync(path.join(sessions, "-other", "junk.jsonl"), "not json at all\n");

    const first = await run(["import", "omp", "--dir", sessions], { env: sb.env, cwd: sb.work });
    assert.equal(first.code, 0, first.stderr);
    assert.match(first.stdout, /imported omp_sess-a \(4 events\) into space "proj-x"/);
    assert.match(first.stdout, /1 imported, 0 unchanged, 2 skipped/);
    assert.doesNotMatch(first.stdout, /sess-b/);

    const file = path.join(spaceDir(sb, "proj-x"), "transcripts", "omp_sess-a.json");
    const t = readJson(file);
    assert.equal(t.source, "omp");
    assert.equal(t.external_id, "sess-a");
    assert.equal(t.status, "pending");
    assert.equal(t.events.length, 4);
    assert.ok(!fs.readFileSync(file, "utf8").includes(FAKE_SECRET), "secret must be scrubbed");
    assert.match(t.events[0].content, /\[REDACTED/);

    const again = await run(["import", "omp", "--dir", sessions], { env: sb.env, cwd: sb.work });
    assert.match(again.stdout, /0 imported, 1 unchanged/);

    // the session grows: re-import updates the same transcript and puts it back to pending
    fs.writeFileSync(
      path.join(sessions, "-proj-x", "a.jsonl"),
      session({ id: "sess-a", cwd: sb.work, extra: [j({ type: "message", message: { role: "assistant", content: "One more thing." } })] }),
    );
    const grown = await run(["import", "omp", "--dir", sessions], { env: sb.env, cwd: sb.work });
    assert.match(grown.stdout, /imported omp_sess-a \(5 events\)/);

    // --all takes sessions of every directory, each into the space named after its cwd
    const all = await run(["import", "omp", "--dir", sessions, "--all"], { env: sb.env, cwd: sb.work });
    assert.match(all.stdout, /omp_sess-b/);
    assert.ok(fs.existsSync(path.join(spaceDir(sb, "elsewhere"), "transcripts", "omp_sess-b.json")));
  } finally {
    sb.cleanup();
  }
});

test("import usage errors and --session", async () => {
  const sb = sandbox();
  try {
    const bad = await run(["import", "claude"], { env: sb.env, cwd: sb.work });
    assert.equal(bad.code, 2);
    const missing = await run(["import", "omp", "--dir", path.join(sb.root, "nope")], { env: sb.env, cwd: sb.work });
    assert.equal(missing.code, 2);
    assert.match(missing.stderr, /Cannot read the omp sessions folder/);
    const file = path.join(sb.root, "one.jsonl");
    fs.writeFileSync(file, session({ id: "sess-one", cwd: path.join(sb.root, "any") }));
    const one = await run(["import", "omp", "--session", file, "--space", "mine"], { env: sb.env, cwd: sb.work });
    assert.equal(one.code, 0, one.stderr);
    assert.ok(fs.existsSync(path.join(spaceDir(sb, "mine"), "transcripts", "omp_sess-one.json")));
  } finally {
    sb.cleanup();
  }
});
