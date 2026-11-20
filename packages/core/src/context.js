import { MemoryWiki } from "./wiki.js";

export const INDEX_PATH = "/_index.md";

function indexOf(wiki) {
  if (wiki instanceof MemoryWiki) return wiki.get(INDEX_PATH)?.content ?? null;
  if (wiki && typeof wiki.get === "function") return wiki.get(INDEX_PATH)?.content ?? null;
  if (wiki && typeof wiki === "object" && Object.hasOwn(wiki, INDEX_PATH)) return String(wiki[INDEX_PATH]);
  return null;
}

/**
 * The small text injected at the start of a session.
 * `/_index.md` is cut at the last full line that fits in `maxChars`; without an
 * index the newest notes ("Recent notes:\n- ...") are used; otherwise "".
 * @param {object|MemoryWiki|null} wiki snapshot `{path: content}` or a DocsApi
 * @param {{id?:string, ts:string, content:string}[]} [notes]
 * @param {{maxChars?:number}} [opts]
 * @returns {{content:string, source:"index"|"notes"|"empty", truncated:boolean}}
 */
export function buildContext(wiki, notes = [], { maxChars = 4096 } = {}) {
  const index = indexOf(wiki);
  if (index !== null && index.trim() !== "") {
    if (index.length <= maxChars) return { content: index, source: "index", truncated: false };
    let cut = index.lastIndexOf("\n", maxChars);
    if (cut <= 0) cut = maxChars;
    return { content: index.slice(0, cut), source: "index", truncated: true };
  }
  const sorted = (Array.isArray(notes) ? notes : [])
    .filter((n) => n && typeof n.content === "string" && n.content.trim() !== "")
    .map((n, i) => ({ n, i }))
    .sort((a, b) => (a.n.ts === b.n.ts ? b.i - a.i : a.n.ts < b.n.ts ? 1 : -1))
    .map((x) => x.n);
  if (sorted.length === 0) return { content: "", source: "empty", truncated: false };
  let content = "Recent notes:";
  let used = 0;
  for (const n of sorted) {
    const line = `\n- ${n.content.replace(/\s+/g, " ").trim()}`;
    if (content.length + line.length > maxChars) break;
    content += line;
    used++;
  }
  if (used === 0) return { content: "", source: "empty", truncated: true };
  return { content, source: "notes", truncated: used < sorted.length };
}
