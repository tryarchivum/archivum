import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { READ_ONLY_TOOLS, withAnnotations } from "../src/mcp.js";

const bin = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "archivum.js");

function listTools() {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [bin, "mcp"], { env: { ...process.env, ARCHIVUM_HOME: path.join(process.env.TMPDIR ?? process.env.TEMP ?? "/tmp", "ann-home") }, stdio: ["pipe", "pipe", "ignore"] });
    let buf = "";
    p.stdout.on("data", (d) => {
      buf += d;
      for (const line of buf.split("\n")) {
        if (!line.trim()) continue;
        try {
          const m = JSON.parse(line);
          if (m.id === 2) { p.kill(); resolve(m.result.tools); }
        } catch { /* partial line */ }
      }
    });
    p.on("error", reject);
    p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } }) + "\n");
    p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n");
    setTimeout(() => { p.kill(); reject(new Error("timeout")); }, 15000);
  });
}

test("every MCP tool is annotated, and only pure reads are read-only", async () => {
  const tools = await listTools();
  assert.equal(tools.length, 17);
  for (const t of tools) {
    assert.equal(typeof t.annotations?.readOnlyHint, "boolean", `${t.name} has no readOnlyHint`);
    assert.equal(t.annotations.readOnlyHint, READ_ONLY_TOOLS.has(t.name), t.name);
  }
  const readOnly = tools.filter((t) => t.annotations.readOnlyHint).map((t) => t.name).sort();
  assert.deepEqual(readOnly, [...READ_ONLY_TOOLS].sort());
});

test("tools that write or delete are never marked read-only; forget is the only destructive one", async () => {
  const tools = await listTools();
  const by = Object.fromEntries(tools.map((t) => [t.name, t.annotations]));
  for (const name of ["remember", "update_note", "save_transcript", "forget", "dream_prepare", "dream_submit"]) {
    assert.equal(by[name].readOnlyHint, false, `${name} writes`);
  }
  assert.equal(by.forget.destructiveHint, true);
  for (const name of ["remember", "update_note", "save_transcript", "dream_prepare", "dream_submit"]) assert.equal(by[name].destructiveHint, false, name);
  assert.equal(by.recall.destructiveHint, undefined, "a read-only tool carries no destructive hint");
});

test("withAnnotations keeps the original tool fields", () => {
  const t = withAnnotations({ name: "recall", description: "d", inputSchema: { type: "object" } });
  assert.equal(t.description, "d");
  assert.deepEqual(t.inputSchema, { type: "object" });
});
