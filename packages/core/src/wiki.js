// In-memory wiki: the synchronous DocsApi used by the dream engine, the CLI
// (as the staging wiki) and the website simulation.
// Errors are `Error` objects with `.code` in
// "conflict" | "not_found" | "invalid_path" | "too_large" | "quota".

import { parseFrontmatter } from "./frontmatter.js";
import { sha256Hex } from "./sha256.js";

export const MAX_PATH_CHARS = 200;
export const MAX_DOC_BYTES = 100_000;
export const MAX_DOCS = 2000;

const PATH_RE = /^\/[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;
const encoder = new TextEncoder();
const byteLength = (s) => encoder.encode(s).length;

export function docError(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

export function validatePath(path) {
  // Exactly as strict as the CLI's isDocPath (packages/cli/src/store.js): a path accepted here is written to disk by `apply`,
  // so a mismatch would make the dream's result fail at the very end. No ".." anywhere and no "." segment.
  if (typeof path !== "string" || path.length > MAX_PATH_CHARS || !PATH_RE.test(path) || path.includes("..") || path.split("/").includes(".")) {
    throw docError(
      "invalid_path",
      `Invalid path: it must start with "/", use segments of letters, digits, ".", "_" or "-", contain no ".." and no "." segment, and be at most ${MAX_PATH_CHARS} characters.`,
    );
  }
  return path;
}

export class MemoryWiki {
  /**
   * @param {Record<string,string>} [initial] `{ "/path.md": "content" }`
   * @param {{maxDocs?:number, maxBytes?:number}} [opts]
   */
  constructor(initial = {}, { maxDocs = MAX_DOCS, maxBytes = MAX_DOC_BYTES } = {}) {
    this.maxDocs = maxDocs;
    this.maxBytes = maxBytes;
    /** @type {Map<string,{content:string, sha256:string, bytes:number}>} */
    this._store = new Map();
    for (const [path, content] of Object.entries(initial ?? {})) {
      validatePath(path);
      this._put(path, String(content));
    }
  }

  _put(path, content) {
    const sha256 = sha256Hex(content);
    this._store.set(path, { content, sha256, bytes: byteLength(content) });
    return { path, sha256 };
  }

  /** @returns {{path:string, bytes:number, sha256:string, name:string|null, description:string|null}[]} sorted by path */
  list({ prefix } = {}) {
    if (prefix !== undefined && prefix !== null && prefix !== "" && !String(prefix).startsWith("/")) {
      throw docError("invalid_path", 'prefix must start with "/"');
    }
    return [...this._store.entries()]
      .filter(([p]) => !prefix || p.startsWith(prefix))
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([path, d]) => {
        const fm = parseFrontmatter(d.content);
        return { path, bytes: d.bytes, sha256: d.sha256, name: fm.name, description: fm.description };
      });
  }

  /** @returns {{path:string, content:string, sha256:string}|null} */
  get(path) {
    validatePath(path);
    const d = this._store.get(path);
    return d ? { path, content: d.content, sha256: d.sha256 } : null;
  }

  has(path) {
    return this._store.has(path);
  }

  /**
   * Creates or overwrites. With `expectSha256` the write only succeeds when the
   * current sha matches (a missing document never matches): otherwise `conflict`.
   */
  write(path, content, { expectSha256 } = {}) {
    validatePath(path);
    if (typeof content !== "string") throw docError("too_large", "content must be a string");
    if (byteLength(content) > this.maxBytes) throw docError("too_large", `Document exceeds ${this.maxBytes} bytes.`);
    const cur = this._store.get(path);
    if (expectSha256 !== undefined && expectSha256 !== null && (cur?.sha256 ?? null) !== expectSha256) {
      throw docError("conflict", `${path} changed since it was read.`);
    }
    if (!cur && this._store.size >= this.maxDocs) throw docError("quota", `Document limit of ${this.maxDocs} reached.`);
    return this._put(path, content);
  }

  delete(path) {
    validatePath(path);
    if (!this._store.delete(path)) throw docError("not_found", `${path} does not exist.`);
  }

  rename(from, to) {
    validatePath(from);
    validatePath(to);
    const d = this._store.get(from);
    if (!d) throw docError("not_found", `${from} does not exist.`);
    if (this._store.has(to)) throw docError("conflict", `${to} already exists.`);
    this._store.delete(from);
    this._store.set(to, d);
  }

  /** @returns {Record<string,string>} path -> content, keys sorted */
  snapshot() {
    return Object.fromEntries([...this._store.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([p, d]) => [p, d.content]));
  }

  clone() {
    const c = new MemoryWiki({}, { maxDocs: this.maxDocs, maxBytes: this.maxBytes });
    for (const [p, d] of this._store) c._store.set(p, { ...d });
    return c;
  }
}
