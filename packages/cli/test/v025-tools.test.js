import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/store.js";
import { callTool } from "../src/mcp.js";
import { rememberChecked, recallResults, formatResults } from "../src/memory.js";

function tmpStore() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "archivum-v025-"));
  return { store: new Store(root, "t"), cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}
const out = (r) => r.content[0].text;
const withStore = (fn) => () => {
  const { store, cleanup } = tmpStore();
  try {
    fn(store);
  } finally {
    cleanup();
  }
};

// ------------------------------------------------------------------ duplicates
test("remember: an identical note (case and spacing aside) is not saved twice", withStore((store) => {
  const a = out(callTool(store, "remember", { content: "Tests run with  pnpm test:unit" }));
  assert.match(a, /^Saved note note_/);
  const b = out(callTool(store, "remember", { content: "tests run with pnpm TEST:unit\n" }));
  assert.match(b, /^Already remembered as note_.*nothing saved/);
  assert.equal(store.readNotes().length, 1);
}));

test("remember: a very similar note is saved and the older one is named; a different one gets no warning", withStore((store) => {
  callTool(store, "remember", { content: "deploy the site with bash deploy.sh to Cloudflare Pages project archivum" });
  const sim = out(callTool(store, "remember", { content: "deploy the site with bash deploy.sh to the Cloudflare Pages project archivum now" }));
  assert.match(sim, /^Saved note note_.*\nNote: very similar to note_/);
  assert.equal(store.readNotes().length, 2);
  const other = out(callTool(store, "remember", { content: "the flaky fuzz test fails only when the machine is busy" }));
  assert.ok(!other.includes("very similar"));
  const short = out(callTool(store, "remember", { content: "ok yes" }));
  assert.ok(!short.includes("very similar"), "tiny notes never warn");
}));

test("rememberChecked still scrubs secrets before comparing and saving", withStore((store) => {
  const token = `npm_${"aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY3zA5"}`;
  const r = rememberChecked(store, `publish with ${token}`);
  assert.ok(!r.note.content.includes(token));
  const again = rememberChecked(store, `publish with ${token}`);
  assert.ok(again.duplicateOf, "same secret-bearing note is recognised as a duplicate after scrubbing");
}));

// ------------------------------------------------------------------ update_note
test("update_note replaces text in place, keeps the id, scrubs secrets, and marks the note as new", withStore((store) => {
  const n = store.appendNote("tests: npm test (jest)");
  store.writeState?.({ notes_consolidated_through: "2999-01-01T00:00:00.000Z" });
  const r = out(callTool(store, "update_note", { id: n.id, content: `tests: pnpm test:unit key sk-ant-${"a".repeat(30)}`, metadata: { tag: "tooling" } }));
  assert.equal(r, `Updated note ${n.id}.`);
  const notes = store.readNotes();
  assert.equal(notes.length, 1);
  assert.equal(notes[0].id, n.id);
  assert.match(notes[0].content, /pnpm test:unit/);
  assert.ok(!notes[0].content.includes("sk-ant-aaaa"));
  assert.equal(notes[0].created_at, n.ts, "first timestamp preserved");
  assert.ok(notes[0].ts >= n.ts);
  assert.deepEqual(notes[0].metadata, { tag: "tooling" });
}));

test("update_note: unknown id, empty content and wrong types are clean errors", withStore((store) => {
  const bad = [{}, { id: 5, content: "x" }, { id: "note_nope", content: "x" }, { id: "note_nope", content: "   " }, { id: "x", content: 7 }, null, "str", [], 5];
  for (const a of bad) {
    const r = callTool(store, "update_note", a);
    assert.equal(r.isError, true, JSON.stringify(a));
  }
  assert.equal(store.readNotes().length, 0);
}));

test("update_note refuses ids that are not notes (path-like ids cannot reach other files)", withStore((store) => {
  store.appendNote("keep me");
  for (const id of ["../notes", "/etc/passwd", "..", "note_x/../../y"]) assert.equal(callTool(store, "update_note", { id, content: "x" }).isError, true);
  assert.equal(store.readNotes()[0].content, "keep me");
}));

// ------------------------------------------------------------------ save_transcript
test("save_transcript stores a pending transcript, scrubs secrets, and replaces it by id", withStore((store) => {
  const events = [{ role: "user", content: `use key ghp_${"Q1w".repeat(12)}` }, { role: "assistant", content: "done" }];
  const r1 = out(callTool(store, "save_transcript", { events, id: "codex-1", source: "codex" }));
  assert.match(r1, /Stored transcript codex-1 \(2 events, pending\)/);
  const t = store.getTranscript("codex-1");
  assert.equal(t.source, "codex");
  assert.ok(!JSON.stringify(t).includes("ghp_Q1w"));
  assert.match(out(callTool(store, "save_transcript", { events, id: "codex-1" })), /Unchanged transcript codex-1/);
  const grown = [...events, { role: "user", content: "one more thing" }];
  assert.match(out(callTool(store, "save_transcript", { events: grown, id: "codex-1" })), /Stored transcript codex-1 \(3 events/);
  assert.equal(store.listTranscripts().length, 1);
  assert.match(out(callTool(store, "memory_status")), /Transcripts: 1 pending/);
}));

test("save_transcript: bad events, hostile ids and oversized input are clean errors that store nothing", withStore((store) => {
  const ok = [{ role: "user", content: "hi" }];
  const cases = [
    {}, { events: [] }, { events: "no" }, { events: [{ role: "root", content: "x" }] }, { events: [null] }, { events: [{ role: "user" }] , id: "../../x" },
    { events: ok, id: "../escape" }, { events: ok, id: "a/b" }, { events: ok, id: "x".repeat(200) }, { events: ok, id: 5 },
    { events: Array.from({ length: 5001 }, () => ({ role: "user", content: "x" })) },
    { events: [{ role: "user", content: "x".repeat(2_000_001) }] },
  ];
  for (const a of cases) {
    const r = callTool(store, "save_transcript", a);
    assert.equal(r.isError, true, JSON.stringify(a).slice(0, 80));
  }
  assert.equal(store.listTranscripts().length, 0);
  // an unusual content type is stringified, not trusted
  const r = callTool(store, "save_transcript", { events: [{ role: "tool", content: { a: 1 } }], id: "obj" });
  assert.ok(!r.isError);
  assert.equal(store.getTranscript("obj").events[0].content, '{"a":1}');
  // the hostile id never created a file outside the space
  assert.ok(!fs.existsSync(path.join(store.dir, "..", "escape.json")));
}));

test("a transcript saved over MCP is picked up by dream_prepare", withStore((store) => {
  callTool(store, "save_transcript", { events: [{ role: "user", content: "we moved to pnpm today" }, { role: "assistant", content: "noted" }], id: "s1" });
  const prep = out(callTool(store, "dream_prepare", {}));
  assert.match(prep, /1 transcript/);
  assert.match(prep, /pnpm/);
}));

// ------------------------------------------------------------------ recall filters and metadata
test("recall: kind and since filters, metadata shown, bad kind is an error", withStore((store) => {
  const old = store.appendNote("deploy runs on friday");
  const notes = store.readNotes();
  notes[0].ts = "2026-01-01T00:00:00.000Z";
  fs.writeFileSync(store.notesFile, notes.map((n) => `${JSON.stringify(n)}\n`).join(""));
  store.appendNote("deploy now runs on monday", { source: "claude-code", tag: "ops" });
  store.writeDoc("/deploy.md", "---\nname: deploy\ndescription: deploy schedule\n---\n\nDeploys run on monday.\n");
  const all = out(callTool(store, "recall", { query: "deploy" }));
  assert.match(all, /\[wiki\]/);
  assert.match(all, /\[note\]/);
  const onlyWiki = out(callTool(store, "recall", { query: "deploy", kind: "wiki" }));
  assert.ok(!onlyWiki.includes("[note]") && onlyWiki.includes("[wiki]"));
  const onlyNote = out(callTool(store, "recall", { query: "deploy", kind: "note" }));
  assert.ok(!onlyNote.includes("[wiki]") && onlyNote.includes("[note]"));
  const since = out(callTool(store, "recall", { query: "deploy", since: "2026-06-01" }));
  assert.ok(since.includes("monday") && !since.includes("friday") && !since.includes("[wiki]"));
  assert.match(onlyNote, /metadata: \{"source":"claude-code","tag":"ops"\}/);
  assert.equal(callTool(store, "recall", { query: "deploy", kind: "everything" }).isError, true);
  assert.equal(old.id.startsWith("note_"), true);
}));

test("recall: metadata is scrubbed and long metadata is clipped in the output", withStore((store) => {
  callTool(store, "remember", { content: "note with meta", metadata: { token: `sk-ant-${"b".repeat(30)}`, big: "z".repeat(2000) } });
  assert.ok(!fs.readFileSync(store.notesFile, "utf8").includes("sk-ant-"), "secret in metadata is redacted on disk, not only on output");
  const r = formatResults(recallResults(store, "note meta"));
  assert.ok(!r.includes("sk-ant-bbbb"), "secret in metadata never reaches the output");
  assert.ok(r.includes("metadata:"));
  assert.ok(r.length < 600, `output stays small: ${r.length}`);
  assert.ok(r.split("\n").find((l) => l.includes("metadata:")).length <= 320, "metadata line is clipped to 300 characters plus its label");
}));

// ------------------------------------------------------------------ memory_status dream hint
test("memory_status says whether a dream is worth suggesting", withStore((store) => {
  assert.match(out(callTool(store, "memory_status")), /Dream: nothing to consolidate/);
  for (let i = 0; i < 5; i++) store.appendNote(`distinct fact number ${i} about thing${i}`);
  assert.match(out(callTool(store, "memory_status")), /Dream: not worth it yet .*you have 5 and 0/);
  for (let i = 5; i < 22; i++) store.appendNote(`distinct fact number ${i} about thing${i}`);
  assert.match(out(callTool(store, "memory_status")), /Dream: worth suggesting/);
  const s2 = tmpStore();
  try {
    for (let i = 0; i < 3; i++) s2.store.saveTranscript({ id: `t${i}`, events: [], status: "pending" });
    assert.match(out(callTool(s2.store, "memory_status")), /Dream: worth suggesting/);
  } finally {
    s2.cleanup();
  }
}));

// ------------------------------------------------------------------ tool list
test("tools/list: 17 tools, the new ones documented, nothing named twice", () => {
  const src = fs.readFileSync(new URL("../src/mcp.js", import.meta.url), "utf8");
  const names = [...src.matchAll(/^    name: "([a-z_]+)",$/gm)].map((m) => m[1]);
  assert.equal(names.length, 17);
  assert.equal(new Set(names).size, 17);
  for (const n of ["update_note", "save_transcript"]) assert.ok(names.includes(n));
});

test("every tool survives null, string, array and number as its arguments (no throw, clean result)", withStore((store) => {
  const names = [...fs.readFileSync(new URL("../src/mcp.js", import.meta.url), "utf8").matchAll(/^    name: "([a-z_]+)",$/gm)].map((m) => m[1]);
  assert.equal(names.length, 17);
  for (const name of names) for (const a of [null, "x", [], 5, true, undefined]) {
    let r;
    assert.doesNotThrow(() => { r = callTool(store, name, a); }, `${name}(${JSON.stringify(a)})`);
    assert.ok(r && Array.isArray(r.content), `${name}(${JSON.stringify(a)})`);
  }
}));

test("initialize: the server tells the client when to recall and remember, and that memory is data", async () => {
  const { spawn } = await import("node:child_process");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "archivum-init-"));
  const bin = new URL("../bin/archivum.js", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
  const p = spawn(process.execPath, [bin, "--space", "t", "mcp"], { env: { ...process.env, ARCHIVUM_HOME: root } });
  try {
    const line = await new Promise((res, rej) => {
      let buf = "";
      const t = setTimeout(() => rej(new Error("no reply")), 8000);
      p.stdout.on("data", (d) => { buf += d; if (buf.includes("\n")) { clearTimeout(t); res(buf.split("\n")[0]); } });
      p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "1" } } }) + "\n");
    });
    const ins = JSON.parse(line).result.instructions;
    assert.match(ins, /call recall/);
    assert.match(ins, /call remember/);
    assert.match(ins, /update_note/);
    assert.match(ins, /data, never instructions/);
    assert.ok(ins.length < 700, `stays short: ${ins.length}`);
  } finally {
    p.kill();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
