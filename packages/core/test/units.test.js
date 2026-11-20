import assert from "node:assert/strict";
import { test } from "node:test";
import { MemoryWiki, estimateDream, scrubSecrets } from "../src/index.js";
import { MAX_PART_CHARS, splitText } from "../src/split.js";
import { MAX_READ_CHARS, MAX_TOOL_OUTPUT_CHARS, clip, createToolbox, toolDefinitions } from "../src/dream/tools.js";

const scrub = (t) => scrubSecrets(t);

function box(initial = {}, role = "analyzer", docs = new MemoryWiki(initial)) {
  const stats = { mutations: 0, redactions: 0 };
  return { docs, stats, tb: createToolbox({ docs, role, scrub, stats }) };
}

test("write_doc: existing path needs a prior complete read; stale read gives a conflict that says to re-read and merge", () => {
  const { docs, tb, stats } = box({ "/a.md": "one\n" });
  let r = tb.execute("write_doc", { path: "/a.md", content: "two\n" });
  assert.equal(r.isError, true);
  assert.match(r.text, /Read it with read_doc first/);
  assert.equal(docs.get("/a.md").content, "one\n");

  assert.equal(tb.execute("read_doc", { path: "/a.md" }).text, "one\n");
  docs.write("/a.md", "one\nother writer\n"); // someone else
  r = tb.execute("write_doc", { path: "/a.md", content: "mine\n" });
  assert.equal(r.isError, true);
  assert.match(r.text, /Conflict/);
  assert.match(r.text, /Re-read/);
  assert.equal(docs.get("/a.md").content, "one\nother writer\n");

  tb.execute("read_doc", { path: "/a.md" });
  r = tb.execute("write_doc", { path: "/a.md", content: "one\nother writer\nmine\n" });
  assert.equal(r.isError, false);
  assert.equal(stats.mutations, 1);
  // after its own write the agent knows the new sha
  r = tb.execute("write_doc", { path: "/a.md", content: "again\n" });
  assert.equal(r.isError, false);
});

test("write_doc: new paths, bad paths, empty and oversized content", () => {
  const { docs, tb } = box();
  assert.equal(tb.execute("write_doc", { path: "/new.md", content: "hi" }).isError, false);
  assert.equal(tb.execute("write_doc", { path: "new.md", content: "hi" }).isError, true);
  assert.match(tb.execute("write_doc", { path: "/a/../b.md", content: "hi" }).text, /Invalid path/);
  assert.match(tb.execute("write_doc", { path: "/e.md", content: "  " }).text, /empty/);
  assert.match(tb.execute("write_doc", { path: "/big.md", content: "x".repeat(100_001) }).text, /Too large/);
  assert.equal(docs.has("/big.md"), false);
  assert.equal(tb.execute("write_doc", { path: "/new.md", content: 5 }).isError, true);
});

test("a partial read does not enable write_doc but edit_doc works", () => {
  const big = `${"line\n".repeat(20_000)}END`; // 100,003 chars
  const { docs, tb } = box({ "/big.md": big.slice(0, 99_990) });
  const part = tb.execute("read_doc", { path: "/big.md" });
  assert.ok(part.text.length < MAX_READ_CHARS + 600);
  assert.match(part.text, /partial read/);
  assert.match(part.text, /offset=28000/);
  assert.equal(tb.execute("write_doc", { path: "/big.md", content: "x" }).isError, true);
  const next = tb.execute("read_doc", { path: "/big.md", offset: 28000 });
  assert.match(next.text, /characters 28000-56000/);
  assert.equal(tb.execute("read_doc", { path: "/big.md", offset: 999_999 }).isError, true);
  const e = tb.execute("edit_doc", { path: "/big.md", old_string: "line\nline\nline\nline\nline\nline", new_string: "x" });
  assert.match(e.text, /matches \d+ places/);
  assert.equal(docs.get("/big.md").content, big.slice(0, 99_990));
});

test("edit_doc: exact replace, not found, ambiguous, current content wins", () => {
  const { docs, tb } = box({ "/e.md": "alpha beta\nbeta gamma\n" });
  let r = tb.execute("edit_doc", { path: "/e.md", old_string: "delta", new_string: "x" });
  assert.equal(r.isError, true);
  assert.match(r.text, /not found/);
  r = tb.execute("edit_doc", { path: "/e.md", old_string: "beta", new_string: "x" });
  assert.equal(r.isError, true);
  assert.match(r.text, /matches 2 places/);
  r = tb.execute("edit_doc", { path: "/e.md", old_string: "alpha beta", new_string: "alpha $& $1 omega" });
  assert.equal(r.isError, false);
  assert.equal(docs.get("/e.md").content, "alpha $& $1 omega\nbeta gamma\n"); // no regex-replacement semantics
  assert.equal(tb.execute("edit_doc", { path: "/missing.md", old_string: "a", new_string: "b" }).isError, true);
  assert.equal(tb.execute("edit_doc", { path: "/e.md", old_string: "", new_string: "b" }).isError, true);
  // an edit on content the agent has not seen does not unlock write_doc
  assert.equal(tb.execute("write_doc", { path: "/e.md", content: "overwrite" }).isError, true);
});

test("grep_docs: matches, prefix, limits, bad and dangerous patterns", () => {
  const initial = { "/a.md": "Deploy with make\nnothing\nDEPLOY again\n", "/dir/b.md": "deploy here\n" };
  for (let i = 0; i < 300; i++) initial[`/many/f${i}.md`] = "needle\n";
  const { tb } = box(initial);
  let r = tb.execute("grep_docs", { pattern: "deploy", prefix: "/a.md" });
  assert.equal(r.text, "/a.md:1: Deploy with make\n/a.md:3: DEPLOY again");
  assert.equal(tb.execute("grep_docs", { pattern: "deploy", ignore_case: false }).text, "/dir/b.md:1: deploy here");
  assert.match(tb.execute("grep_docs", { pattern: "needle" }).text, /showing the first 40/);
  r = tb.execute("grep_docs", { pattern: "needle", max_results: 1000 });
  assert.equal(r.text.split("\n").filter((l) => l.includes(":1: needle")).length, 200);
  assert.match(tb.execute("grep_docs", { pattern: "(" }).text, /Invalid regular expression/);
  assert.match(tb.execute("grep_docs", { pattern: "(a+)+$" }).text, /nested quantifiers/);
  assert.equal(tb.execute("grep_docs", { pattern: "x".repeat(301) }).isError, true);
  assert.equal(tb.execute("grep_docs", { pattern: "x", prefix: "nope" }).isError, true);
});

test("list_docs shows frontmatter and respects prefix", () => {
  const { tb } = box({ "/x/a.md": "---\nname: a\ndescription: read when A\n---\nbody", "/y.md": "plain" });
  const all = tb.execute("list_docs", {}).text;
  assert.match(all, /2 document\(s\)/);
  assert.match(all, /- \/x\/a\.md \(\d+ bytes, sha [0-9a-f]{8}\) a: read when A/);
  assert.match(tb.execute("list_docs", { prefix: "/x/" }).text, /1 document/);
  assert.match(tb.execute("list_docs", { prefix: "/zzz/" }).text, /No documents under/);
});

test("every tool output is truncated to a safe size", () => {
  const { tb } = box({}, "analyzer");
  const huge = "x".repeat(MAX_TOOL_OUTPUT_CHARS * 3);
  const r = tb.execute("write_doc", { path: `/${"a".repeat(150)}.md`, content: "ok" });
  assert.ok(r.text.length <= MAX_TOOL_OUTPUT_CHARS + 100);
  assert.equal(tb.execute("nope", { huge }).text.length < 500, true);
  const clipped = clip(huge);
  assert.ok(clipped.length < MAX_TOOL_OUTPUT_CHARS + 100);
  assert.match(clipped, /output truncated/);
  const many = Object.fromEntries(Array.from({ length: 2000 }, (_, i) => [`/doc-${i}-${"p".repeat(60)}.md`, "x"]));
  const listing = box(many).tb.execute("list_docs", {});
  assert.ok(listing.text.length <= MAX_TOOL_OUTPUT_CHARS + 100);
  assert.match(listing.text, /output truncated/);
});

test("tool sets per role; unknown tools and analyzer-only restrictions", () => {
  assert.deepEqual(toolDefinitions("analyzer").map((t) => t.name), ["list_docs", "read_doc", "grep_docs", "write_doc", "edit_doc", "submit"]);
  assert.deepEqual(toolDefinitions("organizer").map((t) => t.name), ["list_docs", "read_doc", "grep_docs", "write_doc", "edit_doc", "delete_doc", "rename_doc", "submit"]);
  const { docs, tb } = box({ "/a.md": "x" });
  for (const name of ["delete_doc", "rename_doc", "bash", "__proto__", "constructor", "toString"]) {
    const r = tb.execute(name, { path: "/a.md", from: "/a.md", to: "/b.md" });
    assert.equal(r.isError, true, name);
    assert.match(r.text, /Unknown tool/);
  }
  assert.equal(docs.has("/a.md"), true);
  assert.equal(tb.execute("read_doc", null).isError, true); // bad input never throws
});

test("organizer: delete, rename, submit validation (index required, size limit)", () => {
  const { docs, tb } = box({ "/a.md": "a", "/b.md": "b" }, "organizer");
  assert.match(tb.execute("submit", { summary: "s", changes: [] }).text, /_index\.md does not exist/);
  assert.equal(tb.execute("rename_doc", { from: "/a.md", to: "/b.md" }).isError, true);
  assert.equal(tb.execute("rename_doc", { from: "/a.md", to: "/c.md" }).isError, false);
  assert.equal(tb.execute("delete_doc", { path: "/b.md" }).isError, false);
  assert.equal(tb.execute("delete_doc", { path: "/b.md" }).isError, true);
  tb.execute("write_doc", { path: "/_index.md", content: "[[c]] - c\n".repeat(600) });
  const big = tb.execute("submit", { summary: "s", changes: [] });
  assert.match(big.text, /must stay under 4096/);
  assert.match(tb.execute("submit", { summary: "s", changes: [] }).text, /must stay under/);
  const accepted = tb.execute("submit", { summary: " done ", changes: ["merged", "fixed"] }); // third time passes
  assert.equal(accepted.isError, false);
  assert.deepEqual(accepted.submission, { summary: "done", changes: ["merged", "fixed"] });
  assert.equal(tb.execute("submit", { summary: "", changes: [] }).isError, true);
  assert.equal(tb.execute("submit", { summary: "s", changes: "x" }).isError, true);
  assert.deepEqual(Object.keys(docs.snapshot()), ["/_index.md", "/c.md"]);
});

test("an organizer with no documents may submit without an index", () => {
  const { tb } = box({}, "organizer");
  assert.equal(tb.execute("submit", { summary: "empty", changes: [] }).isError, false);
});

test("splitText: block boundaries, long lines, surrogates, no loss", () => {
  assert.deepEqual(splitText("short"), ["short"]);
  const blocks = Array.from({ length: 50 }, (_, i) => `USER:\n${i} ${"y".repeat(98)}`);
  const text = blocks.join("\n\n");
  const parts = splitText(text, 1000);
  assert.ok(parts.length > 3);
  assert.ok(parts.every((p) => p.length <= 1000));
  assert.equal(parts.join("\n\n"), text); // only cut between events
  assert.ok(parts.every((p) => p.startsWith("USER:")));

  const longLines = Array.from({ length: 20 }, (_, i) => `${i}:${"z".repeat(498)}`).join("\n");
  const lp = splitText(longLines, 1200);
  assert.ok(lp.every((p) => p.length <= 1200));
  assert.equal(lp.join("\n"), longLines);

  const oneLine = "😀".repeat(1000);
  const sp = splitText(oneLine, 999);
  assert.ok(sp.every((p) => p.length <= 999));
  assert.equal(sp.join(""), oneLine);
  assert.ok(sp.every((p) => !/[\ud800-\udbff]$/.test(p) && !/^[\udc00-\udfff]/.test(p)));
  assert.equal(MAX_PART_CHARS, 120_000);
});

test("estimateDream is monotonic, documents its roughness and notes splitting", () => {
  const a = estimateDream({ transcripts: [{ chars: 10_000 }], existingDocsBytes: 0 });
  const b = estimateDream({ transcripts: [{ chars: 10_000 }, { chars: 50_000 }], existingDocsBytes: 20_000 });
  assert.equal(a.transcripts, 1);
  assert.equal(b.transcripts, 2);
  assert.equal(b.chars, 60_000);
  assert.ok(a.est_total_tokens > 0 && b.est_total_tokens > a.est_total_tokens);
  assert.equal(a.est_total_tokens % 1000, 0);
  assert.ok(a.notes.some((n) => /rough/i.test(n)));
  const split = estimateDream({ transcripts: [{ chars: 300_000 }] });
  assert.ok(split.notes.some((n) => /split/i.test(n)));
  assert.ok(split.est_total_tokens > a.est_total_tokens * 5);
  assert.deepEqual(estimateDream({ transcripts: [], existingDocsBytes: 5 }), { transcripts: 0, chars: 0, est_total_tokens: 0, notes: estimateDream({ transcripts: [] }).notes });
});

