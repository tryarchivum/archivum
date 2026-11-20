import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { sha256Hex, newId } from "./core.js";
import { CliError, UsageError } from "./errors.js";

const DOC_PATH_RE = /^\/[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;
const ID_RE = /^[A-Za-z0-9_.-]{1,128}$/;

export function userHome(env = process.env) {
  return env.HOME || env.USERPROFILE || os.homedir();
}

export function archivumRoot(env = process.env) {
  return env.ARCHIVUM_HOME ? path.resolve(env.ARCHIVUM_HOME) : path.join(userHome(env), ".archivum");
}

export function sanitizeSpace(name) {
  const s = String(name ?? "").replace(/[^A-Za-z0-9_.-]/g, "-").slice(0, 64);
  if (s === "" || s === "." || s === ".." || /^-+$/.test(s)) return "default";
  return s;
}

/** --space > $ARCHIVUM_SPACE > basename of cwd. */
export function resolveSpace({ space, env = process.env, cwd = process.cwd() } = {}) {
  const explicit = space ?? (env.ARCHIVUM_SPACE || undefined);
  if (explicit !== undefined) return sanitizeSpace(explicit);
  return sanitizeSpace(path.basename(path.resolve(cwd)));
}

export function isDocPath(p) {
  return typeof p === "string" && p.length <= 200 && DOC_PATH_RE.test(p) && !p.includes("..") && !p.split("/").includes(".");
}

export function assertDocPath(p) {
  if (!isDocPath(p)) throw new UsageError(`Invalid document path "${p}". Use something like /topic.md (letters, digits, . _ - and folders).`);
}

export function isSafeId(id) {
  return typeof id === "string" && ID_RE.test(id) && id !== "." && id !== "..";
}

export function atomicWrite(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
  fs.writeFileSync(tmp, data);
  let lastErr;
  for (let i = 0; i < 8; i++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (e) {
      lastErr = e;
      if (e.code !== "EPERM" && e.code !== "EACCES" && e.code !== "EBUSY") break;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 * (i + 1));
    }
  }
  try {
    fs.rmSync(tmp, { force: true });
  } catch {}
  throw lastErr;
}

function readJson(file, fallback) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return fallback;
    throw e;
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new CliError(`${file} is not valid JSON.`);
  }
}

/**
 * Appends one JSON line. A crash can leave a last line without its newline; appending straight after it would glue the
 * new record onto the broken one and lose both, so a missing newline is supplied first.
 */
function appendJsonLine(file, value) {
  let prefix = "";
  try {
    const fd = fs.openSync(file, "r");
    try {
      const { size } = fs.fstatSync(fd);
      if (size > 0) {
        const last = Buffer.alloc(1);
        fs.readSync(fd, last, 0, 1, size - 1);
        if (last[0] !== 0x0a) prefix = "\n";
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  fs.appendFileSync(file, `${prefix}${JSON.stringify(value)}\n`);
}

const nowIso = () => new Date().toISOString();

export class Store {
  constructor(root, space) {
    this.root = root;
    this.space = space;
    this.dir = path.join(root, "spaces", space);
    this.wikiDir = path.join(this.dir, "wiki");
    this.transcriptsDir = path.join(this.dir, "transcripts");
    this.notesFile = path.join(this.dir, "notes.jsonl");
    this.stateFile = path.join(this.dir, "state.json");
    this.historyDir = path.join(this.dir, "history");
    this.historyLog = path.join(this.historyDir, "log.jsonl");
    this.historyFiles = path.join(this.historyDir, "files");
    this.proposalsDir = path.join(this.dir, "proposals");
  }

  static open(opts = {}) {
    const env = opts.env ?? process.env;
    return new Store(archivumRoot(env), resolveSpace({ space: opts.space, env, cwd: opts.cwd }));
  }

  // ---------- notes ----------
  readNotes() {
    let text;
    try {
      text = fs.readFileSync(this.notesFile, "utf8");
    } catch (e) {
      if (e.code === "ENOENT") return [];
      throw e;
    }
    const notes = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const n = JSON.parse(line);
        if (n && typeof n.id === "string" && typeof n.content === "string") notes.push(n);
      } catch {}
    }
    return notes;
  }

  appendNote(content, metadata, source) {
    const note = { id: newId("note"), ts: nowIso(), content };
    if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) note.metadata = metadata;
    if (source && typeof source === "object" && !Array.isArray(source)) note.source = source;
    fs.mkdirSync(this.dir, { recursive: true });
    appendJsonLine(this.notesFile, note);
    return note;
  }

  removeNote(id) {
    const notes = this.readNotes();
    const rest = notes.filter((n) => n.id !== id);
    if (rest.length === notes.length) return false;
    atomicWrite(this.notesFile, rest.map((n) => `${JSON.stringify(n)}\n`).join(""));
    return true;
  }

  /**
   * Replace a note's text in place. The id and position stay; `ts` moves to now so a dream treats it as new, and the first
   * timestamp is kept in `created_at`. Returns the updated note, or null when the id does not exist.
   */
  updateNote(id, content, metadata, source) {
    const notes = this.readNotes();
    const i = notes.findIndex((n) => n.id === id);
    if (i < 0) return null;
    const old = notes[i];
    const note = { ...old, content, ts: nowIso(), created_at: old.created_at ?? old.ts };
    if (metadata !== undefined) note.metadata = metadata;
    // `source` stays the original author; the last editor is recorded next to it.
    if (source && typeof source === "object" && !Array.isArray(source)) note.updated_by = { ...source, ts: note.ts };
    notes[i] = note;
    atomicWrite(this.notesFile, notes.map((n) => `${JSON.stringify(n)}\n`).join(""));
    return note;
  }

  // ---------- state ----------
  readState() {
    const s = readJson(this.stateFile, {});
    return { notes_consolidated_through: typeof s.notes_consolidated_through === "string" ? s.notes_consolidated_through : null };
  }

  writeState(state) {
    atomicWrite(this.stateFile, `${JSON.stringify(state, null, 2)}\n`);
  }

  // ---------- transcripts ----------
  transcriptFile(id) {
    if (!isSafeId(id)) throw new UsageError(`Invalid transcript id "${id}" (letters, digits, _ . - only, up to 128 chars).`);
    return path.join(this.transcriptsDir, `${id}.json`);
  }

  getTranscript(id) {
    return readJson(this.transcriptFile(id), null);
  }

  saveTranscript(t) {
    atomicWrite(this.transcriptFile(t.id), `${JSON.stringify(t)}\n`);
  }

  listTranscripts() {
    let names;
    try {
      names = fs.readdirSync(this.transcriptsDir);
    } catch (e) {
      if (e.code === "ENOENT") return [];
      throw e;
    }
    const out = [];
    for (const n of names) {
      if (!n.endsWith(".json")) continue;
      try {
        const t = JSON.parse(fs.readFileSync(path.join(this.transcriptsDir, n), "utf8"));
        if (t && typeof t.id === "string" && Array.isArray(t.events)) out.push(t);
      } catch {}
    }
    return out;
  }

  deleteTranscript(id) {
    fs.rmSync(this.transcriptFile(id), { force: true });
  }

  /**
   * Create or update a transcript. Returns {transcript, changed}.
   * An existing transcript keeps its id; if its events changed it becomes pending again.
   */
  upsertTranscript({ id, source, externalId = null, events, namespace }) {
    const eventsSha = sha256Hex(JSON.stringify(events));
    const existing = this.getTranscript(id);
    const ts = nowIso();
    if (existing) {
      if (sha256Hex(JSON.stringify(existing.events)) === eventsSha) return { transcript: existing, changed: false };
      const t = { ...existing, source: source ?? existing.source, events, updated_at: ts, status: "pending", dreamed_at: null };
      this.saveTranscript(t);
      return { transcript: t, changed: true };
    }
    const t = {
      id,
      source,
      external_id: externalId,
      namespace: namespace ?? this.space,
      created_at: ts,
      updated_at: ts,
      status: "pending",
      dreamed_at: null,
      events,
    };
    this.saveTranscript(t);
    return { transcript: t, changed: true };
  }

  // ---------- live wiki ----------
  docFile(p) {
    assertDocPath(p);
    return path.join(this.wikiDir, ...p.slice(1).split("/"));
  }

  readDoc(p) {
    try {
      return fs.readFileSync(this.docFile(p), "utf8");
    } catch (e) {
      if (e.code === "ENOENT" || e.code === "EISDIR" || e.code === "ENOTDIR") return null;
      throw e;
    }
  }

  wikiSnapshot() {
    return readTree(this.wikiDir);
  }

  /** Number of wiki documents, counted without reading their content. */
  wikiCount() {
    let n = 0;
    const walk = (dir, rel) => {
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch (e) {
        if (e.code === "ENOENT") return;
        throw e;
      }
      for (const e of entries) {
        const r = `${rel}/${e.name}`;
        if (e.isDirectory()) walk(path.join(dir, e.name), r);
        else if (e.isFile() && isDocPath(r) && !/\.tmp-\d+-[0-9a-f]+$/.test(e.name)) n++;
      }
    };
    walk(this.wikiDir, "");
    return n;
  }

  // ---------- history ----------
  readHistory() {
    let text;
    try {
      text = fs.readFileSync(this.historyLog, "utf8");
    } catch (e) {
      if (e.code === "ENOENT") return [];
      throw e;
    }
    const out = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line));
      } catch {}
    }
    return out;
  }

  /** History entries of one path with 1-based `version` numbers, oldest first. */
  versionsOf(p) {
    return this.readHistory()
      .filter((e) => e.path === p)
      .map((e, i) => ({ ...e, version: i + 1 }));
  }

  readSnapshotFile(file) {
    if (!isSafeId(file)) return null; // snapshot names are "<n>-<sha8>"; "", ".", NUL or a directory name must not reach readFileSync
    try {
      return fs.readFileSync(path.join(this.historyFiles, file), "utf8");
    } catch (e) {
      if (e.code === "ENOENT") return null;
      throw e;
    }
  }

  #logEntry({ p, operation, actor, content }) {
    const log = this.readHistory();
    const n = log.length + 1;
    let sha = null;
    let file = null;
    if (content !== null) {
      sha = sha256Hex(content);
      file = `${n}-${sha.slice(0, 8)}`;
      fs.mkdirSync(this.historyFiles, { recursive: true });
      atomicWrite(path.join(this.historyFiles, file), content);
    }
    const entry = { ts: nowIso(), path: p, operation, actor, sha256: sha, file };
    fs.mkdirSync(this.historyDir, { recursive: true });
    appendJsonLine(this.historyLog, entry);
    return entry;
  }

  /** A human edited the file outside Archivum: keep that state restorable before we overwrite it. */
  #captureExternal(p, current) {
    if (current === null) return;
    const last = this.versionsOf(p).at(-1);
    if (last && last.sha256 === sha256Hex(current)) return;
    this.#logEntry({ p, operation: last ? "update" : "create", actor: "user", content: current });
  }

  /** Write one live wiki file with history. Returns the history entry, or null when nothing changed. */
  writeDoc(p, content, { actor = "user", operation } = {}) {
    const file = this.docFile(p);
    const current = this.readDoc(p);
    if (current === content) return null;
    this.#captureExternal(p, current);
    const entry = this.#logEntry({ p, operation: operation ?? (current === null ? "create" : "update"), actor, content });
    atomicWrite(file, content);
    return entry;
  }

  deleteDoc(p, { actor = "user" } = {}) {
    const file = this.docFile(p);
    const current = this.readDoc(p);
    if (current === null) return null;
    this.#captureExternal(p, current);
    const entry = this.#logEntry({ p, operation: "delete", actor, content: null });
    fs.rmSync(file, { force: true });
    let dir = path.dirname(file);
    while (dir !== this.wikiDir && dir.startsWith(this.wikiDir)) {
      try {
        fs.rmdirSync(dir);
      } catch {
        break;
      }
      dir = path.dirname(dir);
    }
    return entry;
  }

  // ---------- proposals ----------
  proposalDir(id) {
    if (!isSafeId(id)) throw new UsageError(`Invalid proposal id "${id}".`);
    return path.join(this.proposalsDir, id);
  }

  newProposalId() {
    const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
    return `dream-${stamp}-${crypto.randomBytes(3).toString("hex")}`;
  }

  readProposal(id) {
    return readJson(path.join(this.proposalDir(id), "proposal.json"), null);
  }

  writeProposal(proposal) {
    atomicWrite(path.join(this.proposalDir(proposal.id), "proposal.json"), `${JSON.stringify(proposal, null, 2)}\n`);
  }

  readBase(id) {
    return readJson(path.join(this.proposalDir(id), "base.json"), {});
  }

  writeBase(id, base) {
    atomicWrite(path.join(this.proposalDir(id), "base.json"), `${JSON.stringify(base, null, 2)}\n`);
  }

  proposalWikiDir(id) {
    return path.join(this.proposalDir(id), "wiki");
  }

  /** Replace the staged copy of a proposal with `snapshot` ({path: content}). */
  writeProposalWiki(id, snapshot) {
    const dir = this.proposalWikiDir(id);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    for (const [p, content] of Object.entries(snapshot)) {
      assertDocPath(p);
      atomicWrite(path.join(dir, ...p.slice(1).split("/")), content);
    }
  }

  readProposalWiki(id) {
    return readTree(this.proposalWikiDir(id));
  }

  listProposals() {
    let names;
    try {
      names = fs.readdirSync(this.proposalsDir);
    } catch (e) {
      if (e.code === "ENOENT") return [];
      throw e;
    }
    const out = [];
    for (const n of names) {
      if (!isSafeId(n)) continue;
      try {
        const p = this.readProposal(n);
        if (p && p.id === n) out.push(p);
      } catch {}
    }
    return out.sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.id < b.id ? -1 : 1));
  }

  /** Select a proposal by id (or unique id prefix); default = newest one in `preferStatus`, else newest overall. */
  pickProposal(id, preferStatus = "review") {
    const all = this.listProposals();
    if (id) {
      const exact = all.find((p) => p.id === id);
      if (exact) return exact;
      const hits = all.filter((p) => p.id.startsWith(id));
      if (hits.length === 1) return hits[0];
      if (hits.length > 1) throw new UsageError(`"${id}" matches several proposals; use a longer id.`);
      throw new CliError(`No proposal "${id}" in space "${this.space}". Run: archivum proposals`);
    }
    const pref = all.filter((p) => p.status === preferStatus);
    const chosen = pref.at(-1) ?? all.at(-1);
    if (!chosen) throw new CliError(`No proposals in space "${this.space}". Run: archivum dream`);
    return chosen;
  }
}

function readTree(root) {
  const out = {};
  const walk = (dir, rel) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      if (e.code === "ENOENT") return;
      throw e;
    }
    for (const e of entries) {
      const r = `${rel}/${e.name}`;
      if (e.isDirectory()) walk(path.join(dir, e.name), r);
      else if (e.isFile() && isDocPath(r) && !/\.tmp-\d+-[0-9a-f]+$/.test(e.name)) out[r] = fs.readFileSync(path.join(dir, e.name), "utf8");
    }
  };
  walk(root, "");
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : 1)));
}
