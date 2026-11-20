import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { sandbox, run, readJson } from "./helpers.js";

const settingsPath = (sb) => path.join(sb.home, ".claude", "settings.json");
const hookCommands = (settings, event) => (settings.hooks[event] ?? []).flatMap((e) => e.hooks.map((h) => h.command));

test("init merges Claude Code hooks, backs up, is idempotent, registers MCP", async () => {
  const sb = sandbox({ withClaude: true, withCodex: true });
  try {
    fs.mkdirSync(path.join(sb.home, ".claude"), { recursive: true });
    const original = { theme: "dark", hooks: { Stop: [{ hooks: [{ type: "command", command: "echo existing-stop" }] }], PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo pre" }] }] } };
    fs.writeFileSync(settingsPath(sb), JSON.stringify(original, null, 2));

    let r = await run(["init", "--claude-code", "--dry-run"], { env: sb.env, cwd: sb.work });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /would add SessionStart and Stop/);
    assert.match(r.stdout, /would run: claude mcp add archivum -- npx -y archivums mcp/);
    assert.deepEqual(readJson(settingsPath(sb)), original);
    assert.equal(fs.existsSync(`${settingsPath(sb)}.archivum-bak`), false);
    assert.deepEqual(sb.calls(), []);

    r = await run(["init"], { env: sb.env, cwd: sb.work });
    assert.equal(r.code, 0, r.stderr);
    const merged = readJson(settingsPath(sb));
    assert.equal(merged.theme, "dark");
    assert.deepEqual(hookCommands(merged, "SessionStart"), ["npx -y archivums hook session-start"]);
    assert.deepEqual(hookCommands(merged, "Stop"), ["echo existing-stop", "npx -y archivums hook stop"]);
    assert.deepEqual(merged.hooks.PreToolUse, original.hooks.PreToolUse);
    assert.deepEqual(readJson(`${settingsPath(sb)}.archivum-bak`), original);
    const calls = sb.calls();
    assert.ok(calls.some((c) => /^claude mcp add archivum -- npx -y archivums mcp/.test(c)), calls.join("|"));
    assert.ok(calls.some((c) => /^codex mcp add archivum -- npx -y archivums mcp/.test(c)), calls.join("|"));

    // idempotent: no new hooks, backup keeps the ORIGINAL
    const before = fs.readFileSync(settingsPath(sb), "utf8");
    r = await run(["init", "--all"], { env: sb.env, cwd: sb.work });
    assert.equal(r.code, 0);
    assert.match(r.stdout, /hooks already present/);
    assert.equal(fs.readFileSync(settingsPath(sb), "utf8"), before);
    assert.deepEqual(readJson(`${settingsPath(sb)}.archivum-bak`), original);
  } finally {
    sb.cleanup();
  }
});

test("init creates settings.json when missing and honours --home", async () => {
  const sb = sandbox({ withClaude: true });
  try {
    const other = path.join(sb.root, "otherhome");
    const r = await run(["init", "--claude-code", "--home", other], { env: sb.env, cwd: sb.work });
    assert.equal(r.code, 0, r.stderr);
    const s = readJson(path.join(other, ".claude", "settings.json"));
    assert.deepEqual(hookCommands(s, "SessionStart"), ["npx -y archivums hook session-start"]);
    assert.equal(fs.existsSync(path.join(other, ".claude", "settings.json.archivum-bak")), false);
  } finally {
    sb.cleanup();
  }
});

test("init detects clients and prints manual commands when binaries are missing", async () => {
  const sb = sandbox();
  try {
    let r = await run(["init"], { env: sb.env, cwd: sb.work });
    assert.equal(r.code, 0);
    assert.match(r.stdout, /No supported client detected/);

    fs.mkdirSync(path.join(sb.home, ".claude"));
    fs.mkdirSync(path.join(sb.home, ".codex"));
    r = await run(["init"], { env: sb.env, cwd: sb.work });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /`claude` was not found on PATH/);
    assert.match(r.stdout, /claude mcp add archivum -- npx -y archivums mcp/);
    assert.match(r.stdout, /\[mcp_servers\.archivum\]/);
    assert.match(r.stdout, /command = "npx"/);
    assert.match(r.stdout, /args = \["-y", "archivums", "mcp"\]/);
    assert.ok(fs.existsSync(settingsPath(sb)));
  } finally {
    sb.cleanup();
  }
});

test("init refuses to touch invalid settings.json", async () => {
  const sb = sandbox();
  try {
    fs.mkdirSync(path.join(sb.home, ".claude"));
    fs.writeFileSync(settingsPath(sb), "{ not json");
    const r = await run(["init", "--claude-code"], { env: sb.env, cwd: sb.work });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /not valid JSON/);
    assert.equal(fs.readFileSync(settingsPath(sb), "utf8"), "{ not json");
  } finally {
    sb.cleanup();
  }
});
