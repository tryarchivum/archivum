import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/store.js";
import { callTool } from "../src/mcp.js";

function tmpStore() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "archivum-mcp-"));
  return { store: new Store(root, "t"), cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}
const out = (r) => r.content[0].text;

test("memory_status and list_notes reflect what is stored and never mutate", () => {
  const { store, cleanup } = tmpStore();
  try {
    assert.match(out(callTool(store, "memory_status")), /Notes: 0 .*\nWiki documents: 0\nTranscripts: 0 pending, 0 dreamed\nProposals awaiting review: 0\nLast dream: never/);
    assert.equal(out(callTool(store, "list_notes")), "No notes.");
    for (const t of ["first", "second", "third"]) store.appendNote(t);
    store.saveTranscript({ id: "tr_1", events: [], status: "pending" });
    store.saveTranscript({ id: "tr_2", events: [], status: "dreamed" });
    const status = out(callTool(store, "memory_status"));
    assert.match(status, /Notes: 3 \(3 not yet folded/);
    assert.match(status, /Transcripts: 1 pending, 1 dreamed/);
    const notes = out(callTool(store, "list_notes", { limit: 2 }));
    assert.ok(notes.indexOf("third") < notes.indexOf("second"), "newest first");
    assert.ok(!notes.includes("first"), "limit respected");
  } finally {
    cleanup();
  }
});

test("related_documents lists outgoing links, dangling targets and backlinks", () => {
  const { store, cleanup } = tmpStore();
  try {
    store.writeDoc("/a.md", "See [[b]] and [[ghost]] and [[b|the b page]].\n");
    store.writeDoc("/projects/b.md", "Back to [[a]].\n");
    store.writeDoc("/c.md", "Also mentions [[b]].\n");
    const a = out(callTool(store, "related_documents", { path: "/a.md" }));
    assert.match(a, /Links to \(2\):\n\/projects\/b\.md\n\[\[ghost\]\] \(no such document\)/);
    assert.match(a, /Linked from \(1\):\n\/projects\/b\.md/);
    const b = out(callTool(store, "related_documents", { path: "/projects/b.md" }));
    assert.match(b, /Linked from \(2\):\n\/a\.md\n\/c\.md/);
    assert.equal(callTool(store, "related_documents", { path: "/nope.md" }).isError, true);
    assert.equal(callTool(store, "related_documents", { path: "../x" }).isError, true);
  } finally {
    cleanup();
  }
});

test("document_history shows versions with actor", () => {
  const { store, cleanup } = tmpStore();
  try {
    assert.match(out(callTool(store, "document_history", { path: "/a.md" })), /No recorded history/);
    store.writeDoc("/a.md", "one\n", { actor: "dream:d1" });
    store.writeDoc("/a.md", "two\n", { actor: "user" });
    const h = out(callTool(store, "document_history", { path: "/a.md" })).split("\n");
    assert.equal(h.length, 2);
    assert.match(h[0], /^v1 .*create +\(by dream:d1\)$/);
    assert.match(h[1], /^v2 .*update +\(by user\)$/);
  } finally {
    cleanup();
  }
});

test("list_proposals and show_proposal expose the diff but cannot apply it", () => {
  const { store, cleanup } = tmpStore();
  try {
    assert.equal(out(callTool(store, "list_proposals")), "No proposals.");
    assert.equal(callTool(store, "show_proposal").isError, true);
    store.writeDoc("/a.md", "old line\n");
    const id = "dream_20260101_aaaa";
    store.writeBase(id, { "/a.md": "x" });
    store.writeProposal({ id, status: "review", created_at: "2026-01-01T00:00:00.000Z", partial: false });
    store.writeProposalWiki(id, { "/a.md": "new line\n", "/n.md": "added\n" });
    const list = out(callTool(store, "list_proposals"));
    assert.match(list, new RegExp(`${id}  review  2026-01-01T00:00:00.000Z  2 change\\(s\\)`));
    const shown = out(callTool(store, "show_proposal"));
    assert.match(shown, /=== \/n\.md \(added\)/);
    assert.match(shown, /\+new line/);
    assert.match(shown, /archivum apply /);
    assert.deepEqual(Object.keys(store.wikiSnapshot()), ["/a.md"], "showing a proposal never touches the live wiki");
    assert.match(out(callTool(store, "show_proposal", { id: id.slice(0, 12) })), /Proposal dream_20260101_aaaa/);
    assert.equal(callTool(store, "show_proposal", { id: "zzz" }).isError, true);
  } finally {
    cleanup();
  }
});
