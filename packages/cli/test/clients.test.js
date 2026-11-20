import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { sandbox, run } from "./helpers.js";
import { claudeDesktopDir } from "../src/init.js";

// init for Hermes, Cursor and Claude Desktop. Every test runs in a sandbox HOME; the real config files are never touched.
const cursorFile = (sb) => path.join(sb.home, ".cursor", "mcp.json");
const desktopFile = (sb) => path.join(claudeDesktopDir(sb.home, sb.env), "claude_desktop_config.json");
const readJson = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
const hermesShim = (sb, { listOutput = "", cancelOnNoInput = true } = {}) => {
  // a fake `hermes`: `mcp list` prints listOutput, `mcp add` reads one line from stdin and refuses without a "Y" (like the real one)
  const file = path.join(sb.bin, process.platform === "win32" ? "hermes.cmd" : "hermes");
  if (process.platform === "win32") return false;
  fs.writeFileSync(file, `#!/bin/sh
echo "hermes $@" >> "${path.join(sb.root, "calls.log")}"
if [ "$1 $2" = "mcp list" ]; then printf '%s\\n' "${listOutput}"; exit 0; fi
if [ "$1 $2" = "mcp add" ]; then
  read ans
  if [ "$ans" = "Y" ] || [ "$ans" = "y" ]; then echo "saved"; exit 0; fi
  echo "Cancelled."; exit ${cancelOnNoInput ? 0 : 1}
fi
exit 0
`);
  fs.chmodSync(file, 0o755);
  return true;
};

test("init --cursor creates ~/.cursor/mcp.json, keeps other servers, backs up once, is idempotent", async () => {
  const sb = sandbox();
  try {
    fs.mkdirSync(path.dirname(cursorFile(sb)), { recursive: true });
    const original = { mcpServers: { other: { command: "node", args: ["x.js"] } }, keep: { me: true } };
    fs.writeFileSync(cursorFile(sb), JSON.stringify(original));
    let r = await run(["init", "--cursor", "--dry-run"], { env: sb.env, cwd: sb.work });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /would add the archivum server/);
    assert.deepEqual(readJson(cursorFile(sb)), original, "dry run changes nothing");
    r = await run(["init", "--cursor"], { env: sb.env, cwd: sb.work });
    assert.equal(r.code, 0, r.stderr);
    const cfg = readJson(cursorFile(sb));
    assert.deepEqual(cfg.mcpServers.archivum, { command: "npx", args: ["-y", "archivums", "mcp"] });
    assert.deepEqual(cfg.mcpServers.other, original.mcpServers.other, "other servers untouched");
    assert.deepEqual(cfg.keep, original.keep, "unrelated keys untouched");
    assert.deepEqual(readJson(`${cursorFile(sb)}.archivum-bak`), original, "backup holds the original");
    const before = fs.readFileSync(cursorFile(sb), "utf8");
    r = await run(["init", "--cursor"], { env: sb.env, cwd: sb.work });
    assert.match(r.stdout, /already registered/);
    assert.equal(fs.readFileSync(cursorFile(sb), "utf8"), before);
  } finally {
    sb.cleanup();
  }
});

test("init --claude-desktop writes the server where Claude Desktop reads it, in the form that OS needs", async () => {
  const sb = sandbox();
  try {
    const r = await run(["init", "--claude-desktop"], { env: sb.env, cwd: sb.work });
    assert.equal(r.code, 0, r.stderr);
    const entry = readJson(desktopFile(sb)).mcpServers.archivum;
    if (process.platform === "win32") assert.deepEqual(entry, { command: "cmd", args: ["/c", "npx", "-y", "archivums", "mcp"] });
    else assert.deepEqual(entry, { command: "npx", args: ["-y", "archivums", "mcp"] });
    assert.match(r.stdout, /Quit Claude Desktop completely/);
  } finally {
    sb.cleanup();
  }
});

test("a config file init does not understand is left alone, and the other clients are still set up", async () => {
  const sb = sandbox();
  try {
    fs.mkdirSync(path.dirname(cursorFile(sb)), { recursive: true });
    fs.writeFileSync(cursorFile(sb), "{ not json");
    fs.mkdirSync(path.dirname(desktopFile(sb)), { recursive: true });
    fs.writeFileSync(desktopFile(sb), JSON.stringify({ mcpServers: ["wrong shape"] }));
    const r = await run(["init", "--cursor", "--claude-desktop", "--claude-code"], { env: sb.env, cwd: sb.work });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(fs.readFileSync(cursorFile(sb), "utf8"), "{ not json", "invalid JSON untouched");
    assert.match(r.stdout, /not valid JSON; left untouched/);
    assert.deepEqual(readJson(desktopFile(sb)), { mcpServers: ["wrong shape"] }, "wrong shape untouched");
    assert.match(r.stdout, /"mcpServers" in .* is not an object/);
    assert.ok(fs.existsSync(path.join(sb.home, ".claude", "settings.json")), "Claude Code was still set up");
    assert.equal(fs.existsSync(`${cursorFile(sb)}.archivum-bak`), false, "no backup when nothing was written");
  } finally {
    sb.cleanup();
  }
});

test("auto-detect: only the clients that exist on this machine are touched", async () => {
  const sb = sandbox();
  try {
    fs.mkdirSync(path.join(sb.home, ".cursor"), { recursive: true });
    const r = await run(["init"], { env: sb.env, cwd: sb.work });
    assert.equal(r.code, 0, r.stderr);
    assert.ok(fs.existsSync(cursorFile(sb)), "Cursor detected from ~/.cursor");
    assert.equal(fs.existsSync(path.join(sb.home, ".claude")), false, "Claude Code not set up when absent");
    assert.equal(fs.existsSync(desktopFile(sb)), false, "Claude Desktop not set up when absent");
    assert.doesNotMatch(r.stdout, /Hermes:|Codex:/);
    const none = sandbox();
    try {
      const r2 = await run(["init"], { env: none.env, cwd: none.work });
      assert.match(r2.stdout, /No supported client detected/);
      assert.match(r2.stdout, /npx -y archivums mcp/, "tells a user of any other client what to run");
    } finally {
      none.cleanup();
    }
  } finally {
    sb.cleanup();
  }
});

test("init --hermes answers hermes' own confirmation, skips when already registered, and prints the command when hermes is missing", async () => {
  const sb = sandbox();
  try {
    if (!hermesShim(sb)) return; // POSIX shell shim; the logic is OS independent
    let r = await run(["init", "--hermes", "--dry-run"], { env: sb.env, cwd: sb.work });
    assert.match(r.stdout, /would run: hermes mcp add archivum --command npx --args -y archivums mcp/);
    assert.equal(sb.calls().some((c) => c.startsWith("hermes mcp add")), false, "dry run does not add");
    r = await run(["init", "--hermes"], { env: sb.env, cwd: sb.work });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /ran: hermes mcp add archivum/);
    assert.ok(sb.calls().includes("hermes mcp add archivum --command npx --args -y archivums mcp"));
    hermesShim(sb, { listOutput: "  archivum   stdio   17 tools   enabled" });
    r = await run(["init", "--hermes"], { env: sb.env, cwd: sb.work });
    assert.match(r.stdout, /already registered/);
    assert.equal(sb.calls().filter((c) => c.startsWith("hermes mcp add")).length, 1, "not added a second time");
    fs.rmSync(path.join(sb.bin, "hermes"));
    r = await run(["init", "--hermes"], { env: sb.env, cwd: sb.work });
    assert.match(r.stdout, /`hermes` was not found on PATH/);
    assert.match(r.stdout, /hermes mcp add archivum --command npx --args -y archivums mcp/);
  } finally {
    sb.cleanup();
  }
});

test("init --all sets up every client in one run, and one client failing does not stop the rest", async () => {
  const sb = sandbox({ withClaude: true, withCodex: true });
  try {
    hermesShim(sb);
    fs.mkdirSync(path.dirname(cursorFile(sb)), { recursive: true });
    fs.writeFileSync(cursorFile(sb), "{ broken");
    const r = await run(["init", "--all"], { env: sb.env, cwd: sb.work });
    assert.equal(r.code, 0, r.stderr);
    for (const label of ["Claude Code:", "Codex:", "Hermes:", "Cursor:", "Claude Desktop:"]) assert.ok(r.stdout.includes(label), `${label} missing:\n${r.stdout}`);
    assert.ok(fs.existsSync(desktopFile(sb)), "Claude Desktop written although Cursor's file was broken");
    assert.ok(fs.existsSync(path.join(sb.home, ".claude", "settings.json")));
  } finally {
    sb.cleanup();
  }
});

test("the CLI usage text and the npm README list the new client flags", () => {
  const cli = fs.readFileSync(new URL("../src/cli.js", import.meta.url), "utf8");
  const readme = fs.readFileSync(new URL("../README.md", import.meta.url), "utf8");
  for (const f of ["--hermes", "--cursor", "--claude-desktop"]) {
    assert.ok(cli.includes(f), `cli.js misses ${f}`);
    assert.ok(readme.includes(f), `README misses ${f}`);
  }
});
