import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Two agents share one memory; each note should say which client wrote it and which client last changed it.
// The marker comes from the MCP `initialize` clientInfo, never from tool arguments, so a model cannot forge it.
const bin = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "archivum.js");

function setup() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "arch-src-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "arch-proj-"));
  return { home, cwd, env: { ...process.env, ARCHIVUM_HOME: home, ARCHIVUM_SPACE: "duo" }, cleanup() { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(cwd, { recursive: true, force: true }); } };
}

/** One MCP session: initialize with clientInfo, then run tool calls in order. Resolves to the text of each call. */
function mcpSession(env, cwd, clientInfo, calls) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [bin, "mcp"], { env, cwd, stdio: ["pipe", "pipe", "ignore"] });
    const answers = new Map();
    let buf = "";
    p.stdout.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        try {
          const m = JSON.parse(line);
          if (m.id !== undefined) answers.set(m.id, m);
          if (answers.has(calls.length + 1)) { p.kill(); resolve(calls.map((_, k) => answers.get(k + 2)?.result?.content?.[0]?.text ?? "")); }
        } catch { /* partial */ }
      }
    });
    p.on("error", reject);
    const send = (o) => p.stdin.write(`${JSON.stringify(o)}\n`);
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, ...(clientInfo === undefined ? {} : { clientInfo }) } });
    calls.forEach(([name, args], k) => send({ jsonrpc: "2.0", id: k + 2, method: "tools/call", params: { name, arguments: args } }));
    setTimeout(() => { p.kill(); reject(new Error("timeout")); }, 20000);
    // resolve when the last call is answered
    const check = setInterval(() => { if (answers.has(calls.length + 1)) clearInterval(check); }, 20);
  });
}
const readNotes = (home) => fs.readFileSync(path.join(home, "spaces", "duo", "notes.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));

test("a note records the client that wrote it, from the MCP handshake", async () => {
  const sb = setup();
  try {
    const [saved] = await mcpSession(sb.env, sb.cwd, { name: "claude-code", version: "2.1.0" }, [["remember", { content: "Staging box is Falcon-3951." }]]);
    assert.match(saved, /Saved note note_/);
    const [n] = readNotes(sb.home);
    assert.deepEqual(n.source, { client: "claude-code", version: "2.1.0", via: "mcp" });
    assert.equal(n.updated_by, undefined);
  } finally { sb.cleanup(); }
});

test("a second agent updating the note keeps the author and records the editor; still one note", async () => {
  const sb = setup();
  try {
    const [saved] = await mcpSession(sb.env, sb.cwd, { name: "claude-code", version: "2.1.0" }, [["remember", { content: "Tests run with make ship-check." }]]);
    const id = saved.match(/note_[\w-]+/)[0];
    const [updated] = await mcpSession(sb.env, sb.cwd, { name: "codex-mcp-client", version: "0.9" }, [["update_note", { id, content: "Tests run with pnpm vitest." }]]);
    assert.match(updated, /Updated note/);
    const notes = readNotes(sb.home);
    assert.equal(notes.length, 1, "updated in place, not duplicated");
    assert.equal(notes[0].content, "Tests run with pnpm vitest.");
    assert.equal(notes[0].source.client, "claude-code", "the author does not change");
    assert.equal(notes[0].updated_by.client, "codex-mcp-client");
    assert.equal(notes[0].updated_by.via, "mcp");
    assert.ok(notes[0].updated_by.ts);
  } finally { sb.cleanup(); }
});

test("recall and list_notes show who wrote and who edited", async () => {
  const sb = setup();
  try {
    const [saved] = await mcpSession(sb.env, sb.cwd, { name: "claude-code", version: "2.1.0" }, [["remember", { content: "Rollback with make revert-all ENV=staging." }]]);
    const id = saved.match(/note_[\w-]+/)[0];
    await mcpSession(sb.env, sb.cwd, { name: "codex-mcp-client" }, [["update_note", { id, content: "Rollback with make revert-all ENV=staging, then tell #infra." }]]);
    const [recall, list] = await mcpSession(sb.env, sb.cwd, { name: "hermes" }, [["recall", { query: "rollback staging" }], ["list_notes", {}]]);
    assert.match(recall, /by: claude-code 2\.1\.0 \(mcp\); last edited by codex-mcp-client \(mcp\)/);
    assert.match(list, /by claude-code, edited by codex-mcp-client/);
  } finally { sb.cleanup(); }
});

test("a model cannot forge the marker through tool arguments", async () => {
  const sb = setup();
  try {
    const forged = { source: { client: "someone-else", via: "mcp" }, updated_by: { client: "someone-else" } };
    await mcpSession(sb.env, sb.cwd, { name: "claude-code" }, [["remember", { content: "A fact that tries to forge its author.", metadata: forged, source: { client: "evil" }, updated_by: { client: "evil" } }]]);
    const [n] = readNotes(sb.home);
    assert.equal(n.source.client, "claude-code");
    assert.equal(n.updated_by, undefined);
    assert.equal(n.metadata.source.client, "someone-else", "agent-supplied metadata stays metadata, it is not the marker");
  } finally { sb.cleanup(); }
});

test("the client name is cleaned: control characters, secrets and length", async () => {
  const sb = setup();
  try {
    const token = `npm_${"aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY3zA5"}`;
    await mcpSession(sb.env, sb.cwd, { name: `bad\u0007\u001b[31m ${token} ${"x".repeat(200)}`, version: 7 }, [["remember", { content: "Note from an oddly named client." }]]);
    const [n] = readNotes(sb.home);
    assert.ok(!/[\u0000-\u001f]/.test(n.source.client), "no control characters");
    assert.ok(!n.source.client.includes(token), "a secret in the name is scrubbed");
    assert.ok(n.source.client.length <= 64 + 20, "bounded length");
    assert.equal(n.source.version, undefined, "a non-string version is dropped");
  } finally { sb.cleanup(); }
});

test("a client that sends no clientInfo is recorded as unknown, not skipped", async () => {
  const sb = setup();
  try {
    await mcpSession(sb.env, sb.cwd, undefined, [["remember", { content: "Note from a client without clientInfo." }]]);
    assert.deepEqual(readNotes(sb.home)[0].source, { client: "unknown", via: "mcp" });
  } finally { sb.cleanup(); }
});

test("archivum remember from the terminal is marked cli", () => {
  const sb = setup();
  try {
    const r = spawnSync(process.execPath, [bin, "remember", "Typed by hand in the terminal."], { env: sb.env, cwd: sb.cwd, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(readNotes(sb.home)[0].source, { client: "cli", via: "cli" });
    const rec = spawnSync(process.execPath, [bin, "recall", "typed by hand"], { env: sb.env, cwd: sb.cwd, encoding: "utf8" });
    assert.match(rec.stdout, /by: cli \(cli\)/);
  } finally { sb.cleanup(); }
});

test("notes saved before this feature still work and show no writer line", () => {
  const sb = setup();
  try {
    fs.mkdirSync(path.join(sb.home, "spaces", "duo"), { recursive: true });
    fs.writeFileSync(path.join(sb.home, "spaces", "duo", "notes.jsonl"), `${JSON.stringify({ id: "note_old1", ts: "2026-11-01T00:00:00.000Z", content: "An older note about the nightly backup window." })}\n`);
    const rec = spawnSync(process.execPath, [bin, "recall", "nightly backup window"], { env: sb.env, cwd: sb.cwd, encoding: "utf8" });
    assert.equal(rec.status, 0, rec.stderr);
    assert.match(rec.stdout, /note_old1/);
    assert.doesNotMatch(rec.stdout, /by:|edited by/);
  } finally { sb.cleanup(); }
});
