import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { sandbox, run, spaceDir, FAKE_SECRET } from "./helpers.js";

const goodLlm = { ARCHIVUM_LLM_PROVIDER: "anthropic", ARCHIVUM_LLM_API_KEY: FAKE_SECRET };

function writeTranscript(sb, id, extra = {}) {
  const dir = path.join(spaceDir(sb, "proj-x"), "transcripts");
  fs.mkdirSync(dir, { recursive: true });
  const ts = new Date().toISOString();
  const t = { id, source: "t", created_at: ts, updated_at: ts, status: "pending", dreamed_at: null, events: [{ role: "user", content: "hi" }], ...extra };
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(t));
}

/** A shim that prints `text` and exits with `code`. */
function shim(sb, name, text, code = 0) {
  if (process.platform === "win32") fs.writeFileSync(path.join(sb.bin, `${name}.cmd`), `@echo off\r\necho ${text}\r\nexit /b ${code}\r\n`);
  else {
    fs.writeFileSync(path.join(sb.bin, name), `#!/bin/sh\necho "${text}"\nexit ${code}\n`);
    fs.chmodSync(path.join(sb.bin, name), 0o755);
  }
}

const doctorJson = async (sb, env = sb.env) => {
  const r = await run(["doctor", "--json"], { env, cwd: sb.work });
  return { r, checks: JSON.parse(r.stdout) };
};
const byName = (checks, prefix) => checks.find((c) => c.name.startsWith(prefix));

test("doctor on a fresh sandbox: PASS, exit 0, readable checklist with hints", async () => {
  const sb = sandbox();
  try {
    const r = await run(["doctor"], { env: { ...sb.env, ...goodLlm }, cwd: sb.work });
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^PASS\s+node:/m);
    assert.match(r.stdout, /^PASS\s+home:/m);
    assert.match(r.stdout, /^PASS\s+space files:/m);
    assert.match(r.stdout, /^PASS\s+llm config:/m);
    assert.match(r.stdout, /Result: OK/);
    assert.ok(!r.stdout.includes(FAKE_SECRET) && !r.stderr.includes(FAKE_SECRET));
    assert.ok(!fs.existsSync(path.join(sb.archivumHome, "spaces")), "doctor is read-only");
  } finally {
    sb.cleanup();
  }
});

test("doctor --json is an array of {name,status,detail,hint}", async () => {
  const sb = sandbox();
  try {
    const { r, checks } = await doctorJson(sb, { ...sb.env, ...goodLlm });
    assert.equal(r.code, 0);
    assert.ok(Array.isArray(checks) && checks.length >= 6);
    for (const c of checks) {
      assert.deepEqual(Object.keys(c), ["name", "status", "detail", "hint"]);
      assert.ok(["PASS", "WARN", "FAIL"].includes(c.status));
    }
  } finally {
    sb.cleanup();
  }
});

test("doctor: corrupt files => FAIL with count and exit 1", async () => {
  const sb = sandbox();
  try {
    writeTranscript(sb, "good");
    const d = spaceDir(sb, "proj-x");
    fs.writeFileSync(path.join(d, "transcripts", "bad.json"), "{nope");
    fs.writeFileSync(path.join(d, "notes.jsonl"), `${JSON.stringify({ id: "n1", ts: "2026-01-01T00:00:00Z", content: "ok" })}\nnot json\n`);
    fs.writeFileSync(path.join(d, "state.json"), "[broken");
    fs.mkdirSync(path.join(d, "history"), { recursive: true });
    fs.writeFileSync(path.join(d, "history", "log.jsonl"), "garbage\n");
    fs.mkdirSync(path.join(d, "proposals", "dream-x"), { recursive: true });
    fs.writeFileSync(path.join(d, "proposals", "dream-x", "proposal.json"), "{");
    const { r, checks } = await doctorJson(sb, { ...sb.env, ...goodLlm });
    assert.equal(r.code, 1);
    const c = byName(checks, "space files");
    assert.equal(c.status, "FAIL");
    assert.match(c.detail, /5 unreadable of 7/);
    assert.ok(c.hint);
    const text = await run(["doctor"], { env: { ...sb.env, ...goodLlm }, cwd: sb.work });
    assert.equal(text.code, 1);
    assert.match(text.stdout, /^FAIL\s+space files: 5 unreadable/m);
    assert.match(text.stdout, /Result: FAIL/);
  } finally {
    sb.cleanup();
  }
});

test("doctor: unwritable ARCHIVUM_HOME => FAIL", async () => {
  const sb = sandbox();
  try {
    const file = path.join(sb.root, "a-file");
    fs.writeFileSync(file, "x");
    const { r, checks } = await doctorJson(sb, { ...sb.env, ARCHIVUM_HOME: path.join(file, "sub") });
    assert.equal(r.code, 1);
    assert.equal(byName(checks, "home").status, "FAIL");
  } finally {
    sb.cleanup();
  }
});

test("doctor: Claude Code hooks missing => WARN (exit 0), present => PASS", async () => {
  const sb = sandbox();
  try {
    fs.mkdirSync(path.join(sb.home, ".claude"));
    let { r, checks } = await doctorJson(sb, { ...sb.env, ...goodLlm });
    assert.equal(r.code, 0);
    assert.equal(byName(checks, "claude hooks").status, "WARN");

    fs.writeFileSync(path.join(sb.home, ".claude", "settings.json"), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "npx -y archivums hook session-start" }] }] } }));
    ({ checks } = await doctorJson(sb, { ...sb.env, ...goodLlm }));
    const c = byName(checks, "claude hooks");
    assert.equal(c.status, "WARN");
    assert.match(c.detail, /Stop/);
    assert.ok(!/SessionStart/.test(c.detail.replace(/in .*$/, "")));

    const settings = {
      hooks: {
        SessionStart: [{ hooks: [{ type: "command", command: "npx -y archivums hook session-start" }] }],
        Stop: [{ hooks: [{ type: "command", command: "npx -y archivums hook stop" }] }],
      },
    };
    fs.writeFileSync(path.join(sb.home, ".claude", "settings.json"), JSON.stringify(settings));
    ({ checks } = await doctorJson(sb, { ...sb.env, ...goodLlm }));
    assert.equal(byName(checks, "claude hooks").status, "PASS");
  } finally {
    sb.cleanup();
  }
});

test("doctor: MCP check only runs for binaries on PATH; failures are WARN", async () => {
  const sb = sandbox();
  try {
    let { checks } = await doctorJson(sb, { ...sb.env, ...goodLlm });
    assert.match(byName(checks, "mcp (claude)").detail, /not found on PATH/);
    assert.equal(byName(checks, "mcp (claude)").status, "PASS");

    shim(sb, "claude", "archivum: npx -y archivums mcp - Connected");
    shim(sb, "codex", "boom", 3);
    let r;
    ({ r, checks } = await doctorJson(sb, { ...sb.env, ...goodLlm }));
    assert.equal(byName(checks, "mcp (claude)").status, "PASS");
    const codex = byName(checks, "mcp (codex)");
    assert.equal(codex.status, "WARN");
    assert.match(codex.detail, /failed/);
    assert.equal(r.code, 0, "WARN does not fail");

    shim(sb, "claude", "other-server: x");
    ({ checks } = await doctorJson(sb, { ...sb.env, ...goodLlm }));
    assert.equal(byName(checks, "mcp (claude)").status, "WARN");
    assert.match(byName(checks, "mcp (claude)").detail, /not listed/);
  } finally {
    sb.cleanup();
  }
});

test("doctor: LLM config sanity without printing the key", async () => {
  const sb = sandbox();
  try {
    // valid anthropic: defaults noted, key only "set"
    let { checks, r } = await doctorJson(sb, { ...sb.env, ...goodLlm });
    let c = byName(checks, "llm config");
    assert.equal(c.status, "PASS");
    assert.match(c.detail, /api key set/);
    assert.match(c.detail, /claude-haiku-5-5 \(default\)/);
    assert.ok(!r.stdout.includes(FAKE_SECRET));

    // missing key
    ({ checks } = await doctorJson(sb));
    c = byName(checks, "llm config");
    assert.equal(c.status, "WARN");
    assert.match(c.detail, /api key missing/);

    // bad provider
    ({ r, checks } = await doctorJson(sb, { ...sb.env, ...goodLlm, ARCHIVUM_LLM_PROVIDER: "gemini" }));
    assert.equal(byName(checks, "llm config").status, "FAIL");
    assert.equal(r.code, 1);

    // openai: default base URL noted, models required
    ({ checks, r } = await doctorJson(sb, { ...sb.env, ARCHIVUM_LLM_PROVIDER: "openai", ARCHIVUM_LLM_API_KEY: FAKE_SECRET }));
    c = byName(checks, "llm config");
    assert.equal(c.status, "WARN");
    assert.match(c.detail, /base URL default http:\/\/localhost:20128\/v1/);
    assert.match(c.detail, /analyzer model missing/);
    assert.ok(!r.stdout.includes(FAKE_SECRET));

    ({ checks } = await doctorJson(sb, { ...sb.env, ARCHIVUM_LLM_PROVIDER: "openai", ARCHIVUM_LLM_API_KEY: FAKE_SECRET, ARCHIVUM_ANALYZER_MODEL: "a", ARCHIVUM_ORGANIZER_MODEL: "b" }));
    assert.equal(byName(checks, "llm config").status, "PASS");
  } finally {
    sb.cleanup();
  }
});

test("doctor: reports pending transcripts and proposals awaiting review", async () => {
  const sb = sandbox();
  try {
    writeTranscript(sb, "a");
    writeTranscript(sb, "b");
    writeTranscript(sb, "c", { status: "dreamed" });
    const pdir = path.join(spaceDir(sb, "proj-x"), "proposals", "dream-1");
    fs.mkdirSync(pdir, { recursive: true });
    fs.writeFileSync(path.join(pdir, "proposal.json"), JSON.stringify({ id: "dream-1", status: "review", created_at: new Date().toISOString() }));
    const { checks } = await doctorJson(sb, { ...sb.env, ...goodLlm });
    const c = byName(checks, "pending");
    assert.equal(c.status, "PASS");
    assert.match(c.detail, /2 pending transcript\(s\), 1 proposal\(s\) awaiting review/);
  } finally {
    sb.cleanup();
  }
});

test("doctor rejects unknown options with exit 2", async () => {
  const sb = sandbox();
  try {
    const r = await run(["doctor", "--bogus"], { env: sb.env, cwd: sb.work });
    assert.equal(r.code, 2);
  } finally {
    sb.cleanup();
  }
});
