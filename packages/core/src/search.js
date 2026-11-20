// BM25 over notes + wiki. No embeddings: the model navigates through
// /_index.md, links and this keyword search. Deterministic.

import { MemoryWiki } from "./wiki.js";
import { parseFrontmatter } from "./frontmatter.js";

const K1 = 1.5;
const B = 0.75;
const TITLE_WEIGHT = 3;

const STOP = new Set(
  "a an and are as at be but by for from has have i in is it its of on or that the this to was were will with you".split(" "),
);

/** Light suffix stemming; applied identically to documents and queries. */
export function stem(word) {
  let w = word;
  if (w.length > 4 && w.endsWith("ies")) return `${w.slice(0, -3)}y`;
  if (w.length > 4 && w.endsWith("sses")) return w.slice(0, -2);
  if (w.length > 5 && w.endsWith("ing")) {
    w = w.slice(0, -3);
    if (/([^aeiou])\1$/.test(w) && w.length > 3) w = w.slice(0, -1);
    return w;
  }
  if (w.length > 4 && w.endsWith("ed")) {
    w = w.slice(0, -2);
    if (/([^aeiou])\1$/.test(w) && w.length > 3) w = w.slice(0, -1);
    return w;
  }
  if (w.length > 3 && w.endsWith("s") && !/(ss|us|is)$/.test(w)) return w.slice(0, -1);
  return w;
}

/** @returns {string[]} stemmed, lower-cased, stop-word-free tokens (unicode letters/digits) */
export function tokenize(text) {
  const out = [];
  for (const m of String(text ?? "").normalize("NFKC").toLowerCase().matchAll(/[\p{L}\p{N}]+/gu)) {
    if (STOP.has(m[0])) continue;
    out.push(stem(m[0]));
  }
  return out;
}

const clip = (s, n) => (s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`);

function snippetOf(text, queryTerms) {
  const lines = String(text).split("\n").map((l) => l.trim()).filter((l) => l && l !== "---");
  let best = null;
  let bestHits = 0;
  for (const line of lines) {
    const toks = new Set(tokenize(line));
    let hits = 0;
    for (const t of queryTerms) if (toks.has(t)) hits++;
    if (hits > bestHits) {
      bestHits = hits;
      best = line;
    }
  }
  return clip(best ?? lines[0] ?? "", 240);
}

/**
 * Builds the searchable corpus from notes and a wiki.
 * @param {{notes?:{id:string, content:string}[], wiki?:Record<string,string>|MemoryWiki|null}} src
 * @returns {{id:string, kind:"note"|"wiki", title:string, text:string}[]}
 */
export function buildCorpus(src) {
  const { notes = [], wiki = null } = src ?? {};
  const docs = [];
  for (const n of Array.isArray(notes) ? notes : []) {
    if (!n || typeof n.content !== "string") continue;
    const first = n.content.trim().split("\n")[0] ?? "";
    docs.push({ id: n.id, kind: "note", title: clip(first, 80), text: n.content });
  }
  const snap = wiki instanceof MemoryWiki ? wiki.snapshot() : wiki && typeof wiki.snapshot === "function" ? wiki.snapshot() : wiki ?? {};
  for (const [path, content] of Object.entries(snap).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const fm = parseFrontmatter(content);
    const slug = path.replace(/^.*\//, "").replace(/\.[^.]+$/, "");
    docs.push({ id: path, kind: "wiki", title: fm.name ?? slug, text: `${fm.description ? `${fm.description}\n` : ""}${fm.body}` });
  }
  return docs;
}

/**
 * BM25 (k1 1.5, b 0.75). Title tokens count x3 (in term frequency and length).
 * @param {{id:string, kind:"note"|"wiki", title:string, text:string}[]} docs
 * @param {string} query
 * @param {{topK?:number}} [opts]
 * @returns {{id:string, kind:string, score:number, title:string, snippet:string}[]} by score desc, then id
 */
export function searchCorpus(docs, query, { topK = 5 } = {}) {
  const terms = [...new Set(tokenize(query))];
  if (terms.length === 0 || !Array.isArray(docs) || docs.length === 0) return [];
  const indexed = docs.map((d) => {
    const tf = new Map();
    let len = 0;
    for (const t of tokenize(d.text)) {
      tf.set(t, (tf.get(t) ?? 0) + 1);
      len++;
    }
    for (const t of tokenize(d.title)) {
      tf.set(t, (tf.get(t) ?? 0) + TITLE_WEIGHT);
      len += TITLE_WEIGHT;
    }
    return { d, tf, len };
  });
  const avg = indexed.reduce((s, x) => s + x.len, 0) / indexed.length || 1;
  const N = indexed.length;
  const idf = new Map();
  for (const t of terms) {
    let df = 0;
    for (const x of indexed) if (x.tf.has(t)) df++;
    idf.set(t, Math.log(1 + (N - df + 0.5) / (df + 0.5)));
  }
  const hits = [];
  for (const x of indexed) {
    let score = 0;
    for (const t of terms) {
      const f = x.tf.get(t);
      if (!f) continue;
      score += idf.get(t) * ((f * (K1 + 1)) / (f + K1 * (1 - B + B * (x.len / avg))));
    }
    if (score > 0) hits.push({ id: x.d.id, kind: x.d.kind, score, title: x.d.title, snippet: snippetOf(x.d.text, terms), d: x.d });
  }
  hits.sort((a, b) => (b.score !== a.score ? b.score - a.score : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return hits.slice(0, Math.max(0, topK)).map(({ d, ...h }) => h);
}
