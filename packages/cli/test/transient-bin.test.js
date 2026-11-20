import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { sandbox, run } from "./helpers.js";
import { isTransientBinDir, mcpLaunch, findBinary } from "../src/init.js";

// 0.2.11 shipped with a bug found only by re-verifying from the registry: under `npx archivums init`, npm puts the package's own
// node_modules/.bin on PATH, so init believed `archivum` was installed and registered `archivum mcp` - a command that no longer
// exists once npx exits. The same lookup guarded --prompt-recall.
const posix = process.platform !== "win32";
const addShim = (dir, name) => {
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, process.platform === "win32" ? `${name}.cmd` : name);
  fs.writeFileSync(f, posix ? "#!/bin/sh\nexit 0\n" : "@echo off\r\n");
  if (posix) fs.chmodSync(f, 0o755);
};

test("isTransientBinDir: npx cache and node_modules/.bin yes, a global bin no", () => {
  for (const d of ["/home/u/.npm/_npx/ab12cd34/node_modules/.bin", "C:\\Users\\u\\AppData\\Local\\npm-cache\\_npx\\ab12\\node_modules\\.bin", "/proj/node_modules/.bin", "/proj/node_modules/.bin/"]) assert.equal(isTransientBinDir(d), true, d);
  for (const d of ["/usr/local/bin", "C:\\Users\\u\\AppData\\Roaming\\npm", "/home/u/.hermes/node/bin", "/home/u/node_modules_backup/bin"]) assert.equal(isTransientBinDir(d), false, d);
});

test("an `archivum` that exists only in npx's temporary folder is not an installed command", () => {
  const sb = sandbox();
  try {
    const npxBin = path.join(sb.root, "cache", "_npx", "deadbeef", "node_modules", ".bin");
    addShim(npxBin, "archivum");
    const env = { ...sb.env, PATH: [npxBin, sb.env.PATH].join(path.delimiter) };
    assert.ok(findBinary("archivum", env), "a plain lookup sees it");
    assert.equal(findBinary("archivum", env, { installed: true }), null, "an installed-command lookup does not");
    assert.deepEqual(mcpLaunch(env), ["npx", "-y", "archivums", "mcp"]);
    addShim(sb.bin, "archivum");
    assert.deepEqual(mcpLaunch(env), posix ? ["archivum", "mcp"] : ["cmd", "/c", "archivum", "mcp"], "a real installed copy still wins");
  } finally {
    sb.cleanup();
  }
});

test("init run the way npx runs it (temporary .bin first on PATH) still registers npx for the MCP server", async () => {
  const sb = sandbox({ withClaude: true });
  try {
    const npxBin = path.join(sb.root, "cache", "_npx", "deadbeef", "node_modules", ".bin");
    addShim(npxBin, "archivum");
    const env = { ...sb.env, PATH: [npxBin, sb.env.PATH].join(path.delimiter) };
    const r = await run(["init", "--claude-code"], { env, cwd: sb.work });
    assert.equal(r.code, 0, r.stderr);
    assert.ok(sb.calls().includes("claude mcp add archivum -- npx -y archivums mcp"), sb.calls().join("|"));
    assert.ok(!sb.calls().some((c) => /-- (cmd \/c )?archivum mcp/.test(c)), "no registration of a command that vanishes");
  } finally {
    sb.cleanup();
  }
});

test("--prompt-recall is refused when `archivum` exists only in npx's temporary folder", async () => {
  const sb = sandbox();
  try {
    const npxBin = path.join(sb.root, "cache", "_npx", "deadbeef", "node_modules", ".bin");
    addShim(npxBin, "archivum");
    const env = { ...sb.env, PATH: [npxBin, sb.env.PATH].join(path.delimiter) };
    const r = await run(["init", "--claude-code", "--prompt-recall"], { env, cwd: sb.work });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /--prompt-recall skipped/);
    assert.doesNotMatch(fs.readFileSync(path.join(sb.home, ".claude", "settings.json"), "utf8"), /hook user-prompt/);
  } finally {
    sb.cleanup();
  }
});
