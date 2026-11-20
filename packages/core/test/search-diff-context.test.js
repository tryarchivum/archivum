import assert from "node:assert/strict";
import { test } from "node:test";
import { MemoryWiki, buildContext, buildCorpus, diffDocs, lineDiff, searchCorpus, tokenize } from "../src/index.js";

const doc = (id, title, text, kind = "wiki") => ({ id, kind, title, text });

test("tokenize: unicode, lowercase, stemming, stop words", () => {
  assert.deepEqual(tokenize("The Tests are RUNNING, and Über-Größe 42!"), ["test", "run", "über", "größe", "42"]);
  assert.deepEqual(tokenize("tested tests testing"), ["test", "test", "test"]);
  assert.deepEqual(tokenize("deploys deployed policies"), ["deploy", "deploy", "policy"]);
  assert.deepEqual(tokenize("class status"), ["class", "status"]);
});

test("BM25: stemming lets query variants match, ranking by relevance", () => {
  const docs = [
    doc("/a.md", "alpha", "We deployed the service yesterday and the deploy went fine."),
    doc("/b.md", "beta", "Unrelated notes about lunch."),
    doc("/c.md", "gamma", "Deploys happen from main. Deploys are done with make release. deploy deploy"),
  ];
  const r = searchCorpus(docs, "deploying");
  assert.deepEqual(r.map((x) => x.id), ["/c.md", "/a.md"]);
  assert.ok(r[0].score > r[1].score && r[1].score > 0);
  assert.equal(r[0].kind, "wiki");
  assert.match(r[0].snippet, /Deploys/);
  assert.deepEqual(searchCorpus(docs, "lunch").map((x) => x.id), ["/b.md"]);
  assert.deepEqual(searchCorpus(docs, "zebra"), []);
  assert.deepEqual(searchCorpus(docs, ""), []);
  assert.deepEqual(searchCorpus(docs, "the and of"), []);
});

test("BM25: name/title weighs x3 and rare terms beat common ones", () => {
  const docs = [
    doc("/body.md", "misc", "quillon is mentioned once here among other words"),
    doc("/title.md", "quillon", "unrelated words only here among other words"),
    doc("/n1.md", "n1", "common common words"),
    doc("/n2.md", "n2", "common common words"),
  ];
  assert.deepEqual(searchCorpus(docs, "quillon").map((x) => x.id), ["/title.md", "/body.md"]);
  const mixed = searchCorpus(docs, "common quillon");
  assert.equal(mixed[0].id, "/title.md");
  // title token counted three times: a one-word title doc beats a doc that has the word once in the body
  const t = searchCorpus([doc("/x", "word", "other"), doc("/y", "other", "word"), doc("/z", "z", "zzz")], "word");
  assert.equal(t[0].id, "/x");
});

test("BM25: deterministic (ties by id, repeated runs identical), topK", () => {
  const docs = ["/d.md", "/b.md", "/a.md", "/c.md"].map((id) => doc(id, "same", "identical text about build"));
  const first = searchCorpus(docs, "build");
  assert.deepEqual(first.map((x) => x.id), ["/a.md", "/b.md", "/c.md", "/d.md"]);
  assert.deepEqual(searchCorpus([...docs].reverse(), "build"), first);
  assert.deepEqual(searchCorpus(docs, "build", { topK: 2 }).map((x) => x.id), ["/a.md", "/b.md"]);
  assert.equal(searchCorpus(docs, "build").length, 4);
  assert.equal(searchCorpus(docs, "build", { topK: 0 }).length, 0);
});

test("buildCorpus: notes and wiki (snapshot or MemoryWiki), titles from frontmatter or file name", () => {
  const snap = { "/auth-flow.md": "---\nname: Auth Flow\ndescription: how login works\n---\nMagic links.", "/_index.md": "## x\n[[auth-flow]] - login" };
  const notes = [{ id: "note_1", ts: "2026-11-01T00:00:00Z", content: "Remember: tests run with node --test\nsecond line" }];
  const corpus = buildCorpus({ notes, wiki: snap });
  assert.deepEqual(corpus.map((d) => [d.id, d.kind, d.title]), [["note_1", "note", "Remember: tests run with node --test"], ["/_index.md", "wiki", "_index"], ["/auth-flow.md", "wiki", "Auth Flow"]]);
  assert.match(corpus[2].text, /how login works\nMagic links/);
  assert.deepEqual(buildCorpus({ notes, wiki: new MemoryWiki(snap) }), corpus);
  assert.equal(buildCorpus({}).length, 0);
  const hits = searchCorpus(corpus, "magic login");
  assert.equal(hits[0].id, "/auth-flow.md");
  assert.ok(hits[0].title && hits[0].snippet);
  assert.equal(searchCorpus(corpus, "node test")[0].id, "note_1");
});

test("diffDocs: added/modified/removed sorted by path, unchanged omitted", () => {
  const before = { "/b.md": "b", "/a.md": "a", "/gone.md": "g", "/same.md": "s" };
  const after = { "/same.md": "s", "/a.md": "A", "/new.md": "n", "/b.md": "b" };
  assert.deepEqual(diffDocs(before, after), [
    { path: "/a.md", kind: "modified", before: "a", after: "A" },
    { path: "/gone.md", kind: "removed", before: "g", after: null },
    { path: "/new.md", kind: "added", before: null, after: "n" },
  ]);
  assert.deepEqual(diffDocs({}, {}), []);
  assert.deepEqual(diffDocs({ "/e.md": "" }, { "/e.md": "x" }), [{ path: "/e.md", kind: "modified", before: "", after: "x" }]);
});

test("lineDiff: LCS, nothing collapsed", () => {
  assert.deepEqual(lineDiff("a\nb\nc\n", "a\nb\nc\n"), [{ type: "same", text: "a" }, { type: "same", text: "b" }, { type: "same", text: "c" }]);
  assert.deepEqual(lineDiff("a\nb\nc", "a\nx\nc"), [{ type: "same", text: "a" }, { type: "del", text: "b" }, { type: "add", text: "x" }, { type: "same", text: "c" }]);
  assert.deepEqual(lineDiff("", "x\ny"), [{ type: "add", text: "x" }, { type: "add", text: "y" }]);
  assert.deepEqual(lineDiff("x", ""), [{ type: "del", text: "x" }]);
  assert.deepEqual(lineDiff("", ""), []);
  const d = lineDiff("1\n2\n3\n4\n5", "1\n3\n4\n6\n5");
  assert.deepEqual(d.map((x) => (x.type === "same" ? " " : x.type === "add" ? "+" : "-") + x.text), [" 1", "-2", " 3", " 4", "+6", " 5"]);
  // reconstruction invariants on a larger pseudo-random input
  const mk = (seed) => Array.from({ length: 200 }, (_, i) => `line ${(i * seed) % 37}`).join("\n");
  const A = mk(3);
  const B = mk(5);
  const big = lineDiff(A, B);
  assert.equal(big.filter((x) => x.type !== "add").map((x) => x.text).join("\n"), A);
  assert.equal(big.filter((x) => x.type !== "del").map((x) => x.text).join("\n"), B);
});

test("buildContext: index wins, cut at the last full line", () => {
  const index = ["## tools", "[[tests]] - how to run tests", "[[deploy]] - how to ship", "[[auth]] - login"].join("\n");
  const full = buildContext({ "/_index.md": index, "/other.md": "x" }, [{ id: "n", ts: "2026-01-01", content: "ignored" }]);
  assert.deepEqual(full, { content: index, source: "index", truncated: false });
  // cut falls inside the third line -> content ends after line two
  const cutAt = index.indexOf("[[deploy]]") + 5;
  const t = buildContext({ "/_index.md": index }, [], { maxChars: cutAt });
  assert.equal(t.content, "## tools\n[[tests]] - how to run tests");
  assert.equal(t.truncated, true);
  assert.equal(t.source, "index");
  // exactly at a line end
  const end = index.indexOf("\n[[deploy]]");
  assert.equal(buildContext({ "/_index.md": index }, [], { maxChars: end }).content, "## tools\n[[tests]] - how to run tests");
  assert.ok(buildContext({ "/_index.md": index }, [], { maxChars: 40 }).content.length <= 40);
  // single huge line is hard cut
  assert.equal(buildContext({ "/_index.md": "x".repeat(100) }, [], { maxChars: 10 }).content, "x".repeat(10));
  // MemoryWiki instance works too; default maxChars 4096
  const big = `${"[[a]] - line of text\n".repeat(400)}`;
  const c = buildContext(new MemoryWiki({ "/_index.md": big }));
  assert.ok(c.content.length <= 4096 && c.truncated);
  assert.ok(c.content.endsWith("line of text"));
});

test("buildContext: notes fallback (newest first, bounded) and empty", () => {
  const notes = [
    { id: "n1", ts: "2026-11-01T00:00:00Z", content: "oldest" },
    { id: "n3", ts: "2026-11-03T00:00:00Z", content: "newest\nwith newline" },
    { id: "n2", ts: "2026-11-02T00:00:00Z", content: "middle" },
  ];
  assert.deepEqual(buildContext({}, notes), { content: "Recent notes:\n- newest with newline\n- middle\n- oldest", source: "notes", truncated: false });
  assert.deepEqual(buildContext({ "/_index.md": "  \n" }, notes).source, "notes");
  const small = buildContext(null, notes, { maxChars: 45 });
  assert.equal(small.content, "Recent notes:\n- newest with newline\n- middle");
  assert.equal(small.truncated, true);
  assert.deepEqual(buildContext({}, []), { content: "", source: "empty", truncated: false });
  assert.deepEqual(buildContext(null, undefined), { content: "", source: "empty", truncated: false });
});
