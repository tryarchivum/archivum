import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { sandbox, run } from "./helpers.js";
import { claudeDesktopDir, mcpLaunch } from "../src/init.js";

// The MCP server is started by the client. `npx -y archivums` took 2.8-3.7 s per start when measured, the installed command 0.3 s,
// so init registers the installed command when `archivum` is on PATH, and npx only when it is not.
const posix = process.platform !== "win32";
const readJson = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
const hermesShim = (sb) => {
  if (!posix) return false;
  const file = path.join(sb.bin, "hermes");
  fs.writeFileSync(file, `#!/bin/sh\necho "hermes $@" >> "${path.join(sb.root, "calls.log")}"\nif [ "$1 $2" = "mcp list" ]; then exit 0; fi\nif [ "$1 $2" = "mcp add" ]; then read ans; echo saved; exit 0; fi\nexit 0\n`);
  fs.chmodSync(file, 0o755);
  return true;
};

test("mcpLaunch: npx without an installed command, the installed command with one", () => {
  const empty = sandbox();
  const withCmd = sandbox({ withArchivum: true });
  try {
    assert.deepEqual(mcpLaunch(empty.env), ["npx", "-y", "archivums", "mcp"]);
    assert.deepEqual(mcpLaunch(withCmd.env), posix ? ["archivum", "mcp"] : ["cmd", "/c", "archivum", "mcp"]);
  } finally {
    empty.cleanup();
    withCmd.cleanup();
  }
});

test("init --claude-code registers `archivum mcp` when the command is installed, and npx otherwise", async () => {
  const a = sandbox({ withClaude: true, withArchivum: true });
  const b = sandbox({ withClaude: true });
  try {
    let r = await run(["init", "--claude-code"], { env: a.env, cwd: a.work });
    assert.equal(r.code, 0, r.stderr);
    const want = posix ? "claude mcp add archivum -- archivum mcp" : "claude mcp add archivum -- cmd /c archivum mcp";
    assert.ok(a.calls().includes(want), a.calls().join("|"));
    assert.ok(!a.calls().some((c) => c.includes("npx")), "no npx in the MCP registration when the command is installed");
    r = await run(["init", "--claude-code"], { env: b.env, cwd: b.work });
    assert.ok(b.calls().includes("claude mcp add archivum -- npx -y archivums mcp"), b.calls().join("|"));
  } finally {
    a.cleanup();
    b.cleanup();
  }
});

test("init --codex: the manual config.toml hint and the registration follow the same rule", async () => {
  const a = sandbox({ withCodex: true, withArchivum: true });
  const b = sandbox();
  try {
    await run(["init", "--codex", "--no-agents-md"], { env: a.env, cwd: a.work });
    assert.ok(a.calls().includes(posix ? "codex mcp add archivum -- archivum mcp" : "codex mcp add archivum -- cmd /c archivum mcp"), a.calls().join("|"));
    const r = await run(["init", "--codex", "--no-agents-md"], { env: b.env, cwd: b.work });
    assert.match(r.stdout, /command = "npx"/);
    assert.match(r.stdout, /args = \["-y", "archivums", "mcp"\]/);
  } finally {
    a.cleanup();
    b.cleanup();
  }
});

test("init --hermes uses the installed command when present", async () => {
  const sb = sandbox({ withArchivum: true });
  try {
    if (!hermesShim(sb)) return;
    const r = await run(["init", "--hermes"], { env: sb.env, cwd: sb.work });
    assert.equal(r.code, 0, r.stderr);
    assert.ok(sb.calls().includes("hermes mcp add archivum --command archivum --args mcp"), sb.calls().join("|"));
  } finally {
    sb.cleanup();
  }
});

test("Cursor and Claude Desktop keep npx even when the command is installed (GUI apps may not inherit the shell PATH)", async () => {
  const sb = sandbox({ withArchivum: true });
  try {
    const r = await run(["init", "--cursor", "--claude-desktop"], { env: sb.env, cwd: sb.work });
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(readJson(path.join(sb.home, ".cursor", "mcp.json")).mcpServers.archivum, { command: "npx", args: ["-y", "archivums", "mcp"] });
    const desktop = readJson(path.join(claudeDesktopDir(sb.home, sb.env), "claude_desktop_config.json")).mcpServers.archivum;
    assert.ok(JSON.stringify(desktop).includes("npx"), JSON.stringify(desktop));
    assert.ok(!JSON.stringify(desktop).includes('"archivum"'), "no installed command in a GUI client's config");
  } finally {
    sb.cleanup();
  }
});

test("init --dry-run prints the command it would run, with the right form", async () => {
  const sb = sandbox({ withClaude: true, withArchivum: true });
  try {
    const r = await run(["init", "--claude-code", "--dry-run"], { env: sb.env, cwd: sb.work });
    assert.match(r.stdout, posix ? /would run: claude mcp add archivum -- archivum mcp/ : /would run: claude mcp add archivum -- cmd \/c archivum mcp/);
    assert.equal(sb.calls().length, 0, "dry run runs nothing");
  } finally {
    sb.cleanup();
  }
});
