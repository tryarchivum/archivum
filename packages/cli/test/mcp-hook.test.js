import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { sandbox, run, spaceDir, readJson, BIN, FAKE_SECRET } from "./helpers.js";

function mcpSession(sb, space, messages) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, "mcp", "--space", space], { env: sb.env, cwd: sb.work });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", () => resolve({ lines: stdout.split("\n").filter(Boolean).map((l) => JSON.parse(l)), stderr }));
    child.stdin.end(messages.map((m) => (typeof m === "string" ? m : JSON.stringify(m))).join("\n") + "\n");
  });
}

test("mcp server over stdio", async () => {
  const sb = sandbox();
  try {
    const call = (id, name, args) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
    const { lines, stderr } = await mcpSession(sb, "mcp-space", [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "ping" },
      { jsonrpc: "2.0", id: 3, method: "tools/list" },
      call(4, "remember", { content: `The staging db port is 5433 ${FAKE_SECRET}`, metadata: { src: "test" } }),
      call(5, "recall", { query: "staging db port" }),
      call(6, "context", {}),
      call(7, "list_documents", {}),
      call(8, "read_document", { path: "/missing.md" }),
      { jsonrpc: "2.0", id: 9, method: "resources/list" },
      { jsonrpc: "2.0", id: 10, method: "resources/read", params: { uri: "archivum://context" } },
      { jsonrpc: "2.0", id: 11, method: "nope" },
      call(12, "unknown_tool", {}),
      "{broken json",
    ]);
    const byId = new Map(lines.map((l) => [l.id, l]));
    assert.equal(lines.filter((l) => l.id === undefined).length, 0);
    const init = byId.get(1).result;
    assert.equal(init.protocolVersion, "2025-06-18");
    assert.deepEqual(Object.keys(init.capabilities).sort(), ["resources", "tools"]);
    assert.equal(init.serverInfo.name, "archivum");
    assert.deepEqual(byId.get(2).result, {});
    const names = byId.get(3).result.tools.map((t) => t.name).sort();
    assert.deepEqual(names, ["context", "document_history", "dream_prepare", "dream_submit", "forget", "list_documents", "list_notes", "list_proposals", "memory_status", "read_document", "recall", "related_documents", "remember", "save_transcript", "search_documents", "show_proposal", "update_note"]);
    const noteId = /note_[A-Za-z0-9_-]+/.exec(byId.get(4).result.content[0].text)[0];
    assert.match(byId.get(5).result.content[0].text, /\[note\].*5433/s);
    assert.match(byId.get(6).result.content[0].text, /Recent notes:/);
    assert.equal(byId.get(7).result.content[0].text, "No documents.");
    assert.equal(byId.get(8).result.isError, true);
    assert.equal(byId.get(9).result.resources[0].uri, "archivum://context");
    assert.match(byId.get(10).result.contents[0].text, /Recent notes:/);
    assert.equal(byId.get(11).error.code, -32601);
    assert.equal(byId.get(12).error.code, -32602);
    assert.equal(lines.find((l) => l.id === null).error.code, -32700);
    assert.match(stderr, /archivum mcp/);
    const raw = fs.readFileSync(path.join(spaceDir(sb, "mcp-space"), "notes.jsonl"), "utf8");
    assert.ok(!raw.includes(FAKE_SECRET));

    // forget + wiki documents visible to recall/search/read/list
    const wikiDir = path.join(spaceDir(sb, "mcp-space"), "wiki");
    fs.mkdirSync(wikiDir, { recursive: true });
    fs.writeFileSync(path.join(wikiDir, "quillon-tests.md"), "---\nname: quillon-tests\ndescription: how to run quillon tests\n---\nRun `quillon test --fast`.\n");
    fs.writeFileSync(path.join(wikiDir, "_index.md"), "# Index\n[[quillon-tests]] - tests\n");
    const second = await mcpSession(sb, "mcp-space", [
      call(1, "forget", { id: noteId }),
      call(2, "forget", { id: noteId }),
      call(3, "search_documents", { query: "quillon fast tests" }),
      call(4, "read_document", { path: "/quillon-tests.md" }),
      call(5, "list_documents", { prefix: "/quil" }),
      call(6, "context", {}),
    ]);
    const m = new Map(second.lines.map((l) => [l.id, l]));
    assert.match(m.get(1).result.content[0].text, /Forgot/);
    assert.equal(m.get(2).result.isError, true);
    assert.match(m.get(3).result.content[0].text, /\[wiki\].*quillon-tests/s);
    assert.match(m.get(4).result.content[0].text, /quillon test --fast/);
    assert.match(m.get(5).result.content[0].text, /\/quillon-tests\.md.*how to run quillon tests/);
    assert.match(m.get(6).result.content[0].text, /\[\[quillon-tests\]\]/);
  } finally {
    sb.cleanup();
  }
});

function transcriptFixture() {
  const rows = [
    { type: "summary", summary: "ignored" },
    { type: "user", sessionId: "s", message: { role: "user", content: "How do I run the tests?" } },
    { type: "assistant", message: { role: "assistant", content: [{ type: "thinking", thinking: "hmm" }, { type: "text", text: "Try npm test" }, { type: "tool_use", id: "tu1", name: "Bash", input: { command: "npm test" } }] } },
    { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: `ok ${FAKE_SECRET}` }] } },
    { type: "user", isSidechain: true, message: { role: "user", content: "subagent chatter" } },
    { type: "user", isMeta: true, message: { role: "user", content: "meta" } },
  ];
  return rows.map((r) => JSON.stringify(r)).join("\n") + "\nnot json at all\n";
}

test("hooks: session-start injects context, stop stores the transcript", async () => {
  const sb = sandbox();
  try {
    const tpath = path.join(sb.root, "session.jsonl");
    fs.writeFileSync(tpath, transcriptFixture());
    const input = (event) => JSON.stringify({ session_id: "sess-abc", transcript_path: tpath, cwd: sb.work, hook_event_name: event });

    // empty memory: prints nothing
    let r = await run(["hook", "session-start"], { env: sb.env, input: input("SessionStart") });
    assert.equal(r.code, 0);
    assert.equal(r.stdout, "");

    await run(["remember", "Release branch is main"], { env: sb.env, cwd: sb.work });
    r = await run(["hook", "session-start"], { env: sb.env, input: input("SessionStart") });
    assert.equal(r.code, 0);
    const out = JSON.parse(r.stdout);
    assert.deepEqual(Object.keys(out), ["hookSpecificOutput"]);
    assert.equal(out.hookSpecificOutput.hookEventName, "SessionStart");
    assert.match(out.hookSpecificOutput.additionalContext, /^Archivum memory \(space "proj-x"\):\n/);
    assert.match(out.hookSpecificOutput.additionalContext, /Release branch is main/);

    // ARCHIVUM_SPACE overrides the cwd's name
    r = await run(["hook", "session-start"], { env: { ...sb.env, ARCHIVUM_SPACE: "elsewhere" }, input: input("SessionStart") });
    assert.equal(r.stdout, "");

    r = await run(["hook", "stop"], { env: sb.env, input: input("Stop") });
    assert.equal(r.code, 0);
    assert.equal(r.stdout, "");
    const f = path.join(spaceDir(sb, "proj-x"), "transcripts", "sess-abc.json");
    const t = readJson(f);
    assert.equal(t.source, "claude-code");
    assert.equal(t.external_id, "sess-abc");
    assert.equal(t.status, "pending");
    assert.deepEqual(t.events.map((e) => e.role), ["user", "assistant", "tool", "tool"]);
    assert.ok(!JSON.stringify(t).includes(FAKE_SECRET));
    assert.ok(!JSON.stringify(t).includes("subagent chatter"));

    // mark dreamed, repeat with same content: stays dreamed; with more content: back to pending
    fs.writeFileSync(f, JSON.stringify({ ...t, status: "dreamed", dreamed_at: new Date().toISOString() }));
    await run(["hook", "stop"], { env: sb.env, input: input("Stop") });
    assert.equal(readJson(f).status, "dreamed");
    fs.appendFileSync(tpath, JSON.stringify({ type: "assistant", message: { role: "assistant", content: "one more thing" } }) + "\n");
    await run(["hook", "stop"], { env: sb.env, input: input("Stop") });
    const t2 = readJson(f);
    assert.equal(t2.status, "pending");
    assert.equal(t2.dreamed_at, null);
    assert.equal(t2.events.length, 5);
  } finally {
    sb.cleanup();
  }
});

test("hooks never fail the session", async () => {
  const sb = sandbox();
  try {
    for (const input of ["", "garbage", JSON.stringify({ session_id: "x", transcript_path: path.join(sb.root, "missing.jsonl"), cwd: sb.work })]) {
      for (const sub of ["session-start", "stop"]) {
        const r = await run(["hook", sub], { env: sb.env, input });
        assert.equal(r.code, 0, `${sub} with ${input}`);
        assert.equal(r.stderr, "");
      }
    }
    const r = await run(["hook", "stop"], { env: { ...sb.env, ARCHIVUM_DEBUG: "1" }, input: JSON.stringify({ session_id: "x", transcript_path: path.join(sb.root, "missing.jsonl"), cwd: sb.work }) });
    assert.equal(r.code, 0);
    assert.match(r.stderr, /archivum hook stop/);
  } finally {
    sb.cleanup();
  }
});
