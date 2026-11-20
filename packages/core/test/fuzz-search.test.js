import assert from "node:assert/strict";
import { test } from "node:test";
import { MemoryWiki, buildCorpus, searchCorpus, stem, tokenize } from "../src/index.js";
import { anyString, plainWord, property, timeMs, growthRatio } from "./_fuzz.js";

const VOCAB = ["deploy", "release", "docker", "test", "tests", "testing", "tested", "build", "builds", "auth", "login", "database", "migration", "cache", "queue", "lint", "format", "windows", "linux", "branch", "merge", "review", "style", "naming", "secret", "token", "café", "naïve", "日本語", "über", "straße", "ǅ", "ß", "İstanbul", "ﬁle", "Ⅻ", "x2", "42"];

const word = (rng) => (rng.chance(0.7) ? rng.pick(VOCAB) : plainWord(rng));
const sentence = (rng, n = 12) => Array.from({ length: rng.int(0, n) }, () => word(rng)).join(rng.pick([" ", ", ", "\n", " - ", ". "]));

function randomCorpus(rng) {
  const notes = Array.from({ length: rng.int(0, 10) }, (_, i) => ({ id: `note_${rng.int(0, 5)}_${i}`, content: sentence(rng, 30) }));
  const wiki = {};
  for (let i = rng.int(0, 8); i > 0; i--) {
    const p = `/${rng.pick(["a", "b", "topics", "x-y"])}/${rng.pick(VOCAB.filter((w) => /^[a-z0-9]+$/.test(w)))}${rng.int(0, 9)}.md`;
    wiki[p] = `${rng.chance(0.6) ? `---\nname: ${sentence(rng, 3)}\ndescription: ${sentence(rng, 5)}\n---\n` : ""}${sentence(rng, 40)}`;
  }
  return buildCorpus({ notes, wiki });
}

const randomQuery = (rng) => {
  const r = rng.next();
  if (r < 0.1) return "";
  if (r < 0.2) return anyString(rng, 80);
  if (r < 0.3) return rng.pick([" ", "\n\t", "the a an", "(", "[a-z]+", ".*", "\\", "$^", "a|b", "\u0000", "💥", "\ud800", "-", "***", "(?<x>", "__proto__", "constructor", "toString"]);
  return sentence(rng, 6);
};

test("fuzz search: results are ordered, finite, bounded, relevant and deterministic", () => {
  property("search-invariants", (rng) => {
    const docs = randomCorpus(rng);
    const query = randomQuery(rng);
    const topK = rng.pick([undefined, 0, 1, 3, 5, 100, 1000]);
    const opts = topK === undefined ? undefined : { topK };
    const hits = searchCorpus(docs, query, opts);
    assert.ok(Array.isArray(hits));
    assert.ok(hits.length <= (topK ?? 5));
    assert.deepEqual(searchCorpus(docs, query, opts), hits, "not deterministic");
    assert.deepEqual(searchCorpus(structuredClone(docs), query, opts), hits, "depends on object identity");
    for (let i = 0; i < hits.length; i++) {
      const h = hits[i];
      assert.ok(Number.isFinite(h.score) && h.score > 0, `score ${h.score}`);
      assert.equal(typeof h.snippet, "string");
      assert.ok(h.snippet.length <= 240);
      assert.equal(typeof h.title, "string");
      assert.ok(docs.some((d) => d.id === h.id && d.kind === h.kind));
      if (i > 0) {
        const prev = hits[i - 1];
        assert.ok(prev.score > h.score || (prev.score === h.score && prev.id <= h.id), `order ${prev.id}/${prev.score} before ${h.id}/${h.score}`);
      }
    }
    // relevance: with an unbounded topK the hits are exactly the documents sharing a token with the query
    const all = searchCorpus(docs, query, { topK: Infinity });
    const qTokens = new Set(tokenize(query));
    const expectedIds = docs.filter((d) => [...tokenize(d.text), ...tokenize(d.title)].some((t) => qTokens.has(t))).map((d) => `${d.kind}:${d.id}`);
    assert.deepEqual(new Set(all.map((h) => `${h.kind}:${h.id}`)), new Set(expectedIds));
    assert.deepEqual(all.slice(0, hits.length), hits, "topK must be a prefix of the full ranking");
    if (qTokens.size === 0) assert.deepEqual(all, []);
  });
});

test("fuzz search: document order does not change scores or which documents rank", () => {
  property("search-permutation", (rng) => {
    const docs = randomCorpus(rng);
    const query = sentence(rng, 4);
    const base = searchCorpus(docs, query, { topK: 1000 });
    const shuffled = searchCorpus(rng.shuffle(docs), query, { topK: 1000 });
    assert.equal(shuffled.length, base.length);
    const byId = new Map(base.map((h) => [`${h.kind}:${h.id}`, h.score]));
    for (const h of shuffled) {
      const s = byId.get(`${h.kind}:${h.id}`);
      assert.ok(s !== undefined && Math.abs(s - h.score) < 1e-9 * Math.max(1, s), `${h.id}: ${s} vs ${h.score}`);
    }
  });
});

test("fuzz search: a document holding a unique query token is found", () => {
  property("search-needle", (rng) => {
    const needle = `zq${rng.int(100000, 999999)}x`;
    const docs = Array.from({ length: rng.int(1, 12) }, (_, i) => ({ id: `d${i}`, kind: "note", title: sentence(rng, 3), text: sentence(rng, 40) }));
    const at = rng.int(0, docs.length - 1);
    docs[at].text += ` ${rng.pick(["", "see ", "(", '"'])}${needle}${rng.pick(["", ".", ",", ")", '"'])}`;
    assert.deepEqual(searchCorpus(docs, needle).map((h) => h.id), [`d${at}`], "the unique token alone finds exactly its document");
    // with extra (common) words, length normalisation may reorder, but the needle document must still be a hit
    const mixed = searchCorpus(docs, `${sentence(rng, 2)} ${needle}`, { topK: 1000 });
    assert.ok(mixed.some((h) => h.id === `d${at}`));
  });
});

test("fuzz search: odd queries, options and corpora never throw", () => {
  const docs = [
    { id: "a", kind: "note", title: "alpha", text: "alpha beta gamma" },
    { id: "b", kind: "wiki", title: "beta", text: "beta only" },
  ];
  for (const q of [undefined, null, 0, 123, NaN, true, {}, [], ["alpha"], { toString: () => "alpha" }, "", " ", "\0", "\ud800", "a".repeat(200_000), "alpha ".repeat(50_000), "😀".repeat(10_000)]) {
    const hits = searchCorpus(docs, q);
    assert.ok(Array.isArray(hits));
    for (const h of hits) assert.ok(Number.isFinite(h.score));
  }
  for (const topK of [0, -1, -Infinity, Infinity, NaN, 0.5, 1.9, 1e9, "2", null, undefined]) {
    const hits = searchCorpus(docs, "alpha beta", { topK });
    assert.ok(Array.isArray(hits));
    for (const h of hits) assert.ok(Number.isFinite(h.score) && h.score > 0);
  }
  assert.deepEqual(searchCorpus([], "alpha"), []);
  assert.deepEqual(searchCorpus(null, "alpha"), []);
  assert.deepEqual(searchCorpus(undefined, "alpha"), []);
  assert.deepEqual(searchCorpus(docs, "alpha", { topK: -5 }), []);
  assert.deepEqual(searchCorpus(docs, "alpha", {}).map((h) => h.id), ["a"]);
  // documents missing optional fields do not poison the whole search
  const sparse = [{ id: "t", kind: "note", title: undefined, text: "alpha" }, { id: "u", kind: "note", title: "alpha", text: undefined }];
  assert.deepEqual(searchCorpus(sparse, "alpha", { topK: 10 }).map((h) => h.id).sort(), ["t", "u"]);
  // buildCorpus with garbage
  for (const src of [undefined, {}, { notes: null }, { notes: [null, undefined, 5, {}, { content: 5 }, { id: "n", content: "alpha" }, []] }, { wiki: null }, { wiki: {} }, { wiki: { "/a.md": "alpha" } }, { wiki: new MemoryWiki({ "/a.md": "---\nname: n\n---\nbody" }) }, { notes: "str", wiki: "str" }]) {
    assert.ok(Array.isArray(buildCorpus(src)));
  }
});

test("fuzz tokenize/stem: arbitrary text never throws, tokens are non-empty lower-case strings, big inputs are fast", () => {
  property("tokenize", (rng) => {
    const s = rng.chance(0.5) ? anyString(rng, 200) : sentence(rng, 40);
    const toks = tokenize(s);
    for (const t of toks) {
      assert.equal(typeof t, "string");
      assert.ok(t.length > 0);
      assert.ok(/^[\p{L}\p{N}]+$/u.test(t), `token ${JSON.stringify(t)}`);
    }
    assert.deepEqual(tokenize(s), toks);
    assert.equal(typeof stem(rng.str("abcdeinosty", rng.int(0, 12))), "string");
  });
  for (const odd of [undefined, null, 5, {}, [], "\ud800", "\0"]) assert.ok(Array.isArray(tokenize(odd)));
  const big = "lorem ipsum dolor ".repeat(60_000);
  // linear, not quadratic, relative to its own smaller run (the old absolute budget of 1000 ms failed at 287 ms+ on a busy VPS)
  const g = growthRatio((n) => tokenize(big.slice(0, n)), Math.floor(big.length / 16));
  assert.ok(g.large < 5 || g.ratio <= 12, `x${g.ratio.toFixed(1)} (${g.small.toFixed(2)} -> ${g.large.toFixed(2)} ms)`);
  const doc = [{ id: "big", kind: "note", title: "t", text: big }];
  const t = timeMs(() => searchCorpus(doc, "lorem dolor"));
  assert.ok(t.ms < 10_000, `${t.ms} ms (a hang guard, not a speed claim)`);
  assert.equal(t.value.length, 1);
});
