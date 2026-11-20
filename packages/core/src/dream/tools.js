// Document tools exposed to the dream agents (provider-neutral tool definitions).
// One toolbox per agent session: it remembers which documents the agent has
// fully read, because write_doc on an existing path is only allowed after a
// read, and the sha256 of that read becomes the write's precondition.
// Everything here is synchronous: a check and the write that follows it cannot
// interleave with another agent.

import { INDEX_PATH } from "../context.js";
import { MAX_DOC_BYTES } from "../wiki.js";

const encoder = new TextEncoder();
const byteLength = (s) => encoder.encode(s).length;

export const MAX_TOOL_OUTPUT_CHARS = 30_000;
export const MAX_READ_CHARS = 28_000;
export const MAX_GREP_RESULTS = 200;
export const DEFAULT_GREP_RESULTS = 40;
export const INDEX_MAX_CHARS = 4_096;

const MAX_GREP_SCAN_CHARS = 5_000_000;
const MAX_GREP_LINE_CHARS = 2_000;
const NESTED_QUANTIFIER = /\([^()]*[+*][^()]*\)\s*[+*{]/;

const PATH_PROP = { type: "string", description: 'Document path, e.g. "/auth-flow.md". Must start with "/".' };

const DEFS = {
  list_docs: {
    name: "list_docs",
    description:
      "List documents with path, size, short sha and the name/description from their frontmatter. Optionally restrict to a path prefix (a prefix ending in / matches whole folders).",
    input_schema: { type: "object", properties: { prefix: { type: "string", description: 'Optional path prefix, must start with "/".' } } },
  },
  read_doc: {
    name: "read_doc",
    description: `Read one document. Reads up to ${MAX_READ_CHARS} characters; for longer documents use offset to page. Overwriting an existing document with write_doc requires a complete read of it first (in this session).`,
    input_schema: {
      type: "object",
      properties: { path: PATH_PROP, offset: { type: "integer", minimum: 0, description: "Character offset to start from (default 0)." } },
      required: ["path"],
    },
  },
  grep_docs: {
    name: "grep_docs",
    description: `Search all documents line by line with a JavaScript regular expression. Case-insensitive unless ignore_case is false. Returns "path:line: text" matches, at most ${MAX_GREP_RESULTS}.`,
    input_schema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "JavaScript regular expression (no slashes or flags)." },
        prefix: { type: "string", description: 'Only search paths with this prefix (must start with "/").' },
        ignore_case: { type: "boolean", description: "Default true." },
        max_results: { type: "integer", minimum: 1, maximum: MAX_GREP_RESULTS, description: `Default ${DEFAULT_GREP_RESULTS}.` },
      },
      required: ["pattern"],
    },
  },
  write_doc: {
    name: "write_doc",
    description:
      "Create a document or replace the full content of an existing one. Replacing an existing document requires that you read it completely with read_doc earlier in this session; if someone else changed it since, the write fails with a conflict and you must re-read, merge and write again. For small changes to an existing file prefer edit_doc.",
    input_schema: {
      type: "object",
      properties: { path: PATH_PROP, content: { type: "string", description: "Complete new content of the document." } },
      required: ["path", "content"],
    },
  },
  edit_doc: {
    name: "edit_doc",
    description:
      "Replace one exact occurrence of old_string with new_string in the CURRENT content of a document. Fails if old_string is not found or matches more than once (add surrounding context to make it unique). Use it for targeted changes to shared files such as /_index.md.",
    input_schema: {
      type: "object",
      properties: {
        path: PATH_PROP,
        old_string: { type: "string", description: "Exact text to replace, including whitespace." },
        new_string: { type: "string", description: "Replacement text (may be empty to delete)." },
      },
      required: ["path", "old_string", "new_string"],
    },
  },
  delete_doc: {
    name: "delete_doc",
    description: "Delete a document. Only after its content has been merged elsewhere or is a pure duplicate. Every change is versioned and reviewable.",
    input_schema: { type: "object", properties: { path: PATH_PROP }, required: ["path"] },
  },
  rename_doc: {
    name: "rename_doc",
    description: "Rename or move a document. Fails if the destination exists. Update [[links]] and /_index.md yourself afterwards.",
    input_schema: {
      type: "object",
      properties: { from: PATH_PROP, to: PATH_PROP },
      required: ["from", "to"],
    },
  },
};

const SUBMIT_ANALYZER = {
  name: "submit",
  description:
    "Finish. Call exactly once when you are done, after your last write has been verified. Do not call it in the same turn as writes you have not seen succeed.",
  input_schema: {
    type: "object",
    properties: {
      summary: { type: "string", description: "What you verified, corrected and added, and anything contradictory or uncertain you left for the organizer." },
      touched: { type: "array", items: { type: "string" }, description: "Paths you created or changed." },
    },
    required: ["summary"],
  },
};

const SUBMIT_ORGANIZER = {
  name: "submit",
  description: `Finish. Call exactly once when the wiki is consistent. Requires ${INDEX_PATH} to exist.`,
  input_schema: {
    type: "object",
    properties: {
      summary: { type: "string", description: "What you merged, fixed and found, in a few sentences." },
      changes: { type: "array", items: { type: "string" }, description: "One short line per notable change (merged, split, deleted, conflict marked, link fixed ...)." },
    },
    required: ["summary", "changes"],
  },
};

const ANALYZER_TOOLS = ["list_docs", "read_doc", "grep_docs", "write_doc", "edit_doc"];
const ORGANIZER_TOOLS = [...ANALYZER_TOOLS, "delete_doc", "rename_doc"];

export function toolDefinitions(role) {
  if (role === "organizer") return [...ORGANIZER_TOOLS.map((n) => DEFS[n]), SUBMIT_ORGANIZER];
  if (role === "analyzer") return [...ANALYZER_TOOLS.map((n) => DEFS[n]), SUBMIT_ANALYZER];
  throw new Error(`unknown role ${role}`);
}

export function clip(text, max = MAX_TOOL_OUTPUT_CHARS) {
  const s = String(text);
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n[output truncated: ${s.length - max} more characters]`;
}

const short = (s, n = 80) => clip(String(s), n).replace(/\n\[output truncated.*$/s, "...");

const bad = (text) => ({ text: clip(text), isError: true });
const ok = (text) => ({ text: clip(text), isError: false });

function describeDocError(e, path) {
  switch (e?.code) {
    case "conflict":
      return `Conflict: ${path} changed since you last read it (another writer updated it, or it already exists/was moved). Re-read it with read_doc, merge your changes into the current content and write again, or use edit_doc for a targeted change.`;
    case "not_found":
      return `Not found: ${e.message}`;
    case "invalid_path":
      return `${e.message}`;
    case "too_large":
      return `Too large: ${e.message} Split the content into smaller linked files (documents are limited to ${MAX_DOC_BYTES} bytes; aim for far less).`;
    case "quota":
      return `Document quota reached: ${e.message} Merge or delete documents before creating new ones.`;
    default:
      return `Document error: ${e?.message ?? e}`;
  }
}

/**
 * @param {object} o
 * @param {object} o.docs DocsApi (synchronous)
 * @param {"analyzer"|"organizer"} o.role
 * @param {(text:string)=>{text:string,count:number,kinds:string[]}} o.scrub
 * @param {{mutations:number, redactions:number}} o.stats shared across toolboxes of one run
 */
export function createToolbox({ docs, role, scrub, stats }) {
  /** path -> sha256 of the content the agent has seen completely */
  const readShas = new Map();
  let oversizeIndexRejections = 0;
  const definitions = toolDefinitions(role);
  const allowed = new Set(definitions.map((d) => d.name));

  function scrubbed(content) {
    const r = scrub(content);
    stats.redactions += r.count;
    const note = r.count
      ? `\nNote: ${r.count} secret-looking value(s) (${r.kinds.join(", ")}) were replaced with [REDACTED:...]. Never write secrets; record only the credential's name and where it lives.`
      : "";
    return { text: r.text, note };
  }

  const handlers = {
    list_docs(input) {
      const prefix = input.prefix;
      if (prefix !== undefined && typeof prefix !== "string") return bad("prefix must be a string.");
      if (prefix && !prefix.startsWith("/")) return bad('prefix must start with "/".');
      const items = docs.list(prefix ? { prefix } : {});
      if (items.length === 0) return ok(prefix ? `No documents under ${prefix}.` : "No documents yet.");
      const lines = items.map((d) => {
        const label = [d.name, d.description].filter(Boolean).join(": ");
        return `- ${d.path} (${d.bytes} bytes, sha ${d.sha256.slice(0, 8)})${label ? ` ${short(label, 160)}` : ""}`;
      });
      return ok(`${items.length} document(s):\n${lines.join("\n")}`);
    },

    read_doc(input) {
      if (typeof input.path !== "string") return bad("path must be a string.");
      const offset = input.offset === undefined ? 0 : input.offset;
      if (!Number.isInteger(offset) || offset < 0) return bad("offset must be a non-negative integer.");
      let doc;
      try {
        doc = docs.get(input.path);
      } catch (e) {
        return bad(describeDocError(e, input.path));
      }
      if (!doc) return bad(`Not found: ${input.path} does not exist.`);
      const total = doc.content.length;
      if (total === 0) {
        readShas.set(input.path, doc.sha256);
        return ok("[document is empty]");
      }
      if (offset >= total) return bad(`offset ${offset} is past the end of the document (${total} characters).`);
      const end = Math.min(total, offset + MAX_READ_CHARS);
      const slice = doc.content.slice(offset, end);
      if (offset === 0 && end === total) {
        readShas.set(input.path, doc.sha256);
        return ok(slice);
      }
      const more = end < total ? ` Call read_doc with offset=${end} for the next part.` : "";
      return ok(
        `${slice}\n[partial read: characters ${offset}-${end} of ${total}.${more} A partial read does not allow write_doc to overwrite this document; use edit_doc for targeted changes.]`,
      );
    },

    grep_docs(input) {
      if (typeof input.pattern !== "string" || input.pattern === "") return bad("pattern must be a non-empty string.");
      if (input.pattern.length > 300) return bad("pattern is too long (max 300 characters).");
      if (NESTED_QUANTIFIER.test(input.pattern)) return bad("pattern rejected: nested quantifiers like (a+)+ can run catastrophically slow. Simplify it.");
      if (input.prefix !== undefined && (typeof input.prefix !== "string" || !input.prefix.startsWith("/"))) return bad('prefix must be a string starting with "/".');
      let max = input.max_results === undefined ? DEFAULT_GREP_RESULTS : input.max_results;
      if (!Number.isInteger(max) || max < 1) return bad("max_results must be a positive integer.");
      max = Math.min(max, MAX_GREP_RESULTS);
      let re;
      try {
        re = new RegExp(input.pattern, input.ignore_case === false ? "" : "i");
      } catch (e) {
        return bad(`Invalid regular expression: ${e.message}`);
      }
      const hits = [];
      let scanned = 0;
      let stopped = null;
      outer: for (const entry of docs.list(input.prefix ? { prefix: input.prefix } : {})) {
        const doc = docs.get(entry.path);
        if (!doc) continue;
        scanned += doc.content.length;
        if (scanned > MAX_GREP_SCAN_CHARS) {
          stopped = "scan limit reached; narrow the search with prefix";
          break;
        }
        const lines = doc.content.split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (re.test(lines[i].slice(0, MAX_GREP_LINE_CHARS))) {
            if (hits.length >= max) {
              stopped = `more matches exist; showing the first ${max}`;
              break outer;
            }
            hits.push(`${doc.path}:${i + 1}: ${lines[i].slice(0, 300)}`);
          }
        }
      }
      if (hits.length === 0) return ok(stopped ? `No matches (${stopped}).` : "No matches.");
      return ok(`${hits.join("\n")}${stopped ? `\n[${stopped}]` : ""}`);
    },

    write_doc(input) {
      if (typeof input.path !== "string") return bad("path must be a string.");
      if (typeof input.content !== "string") return bad("content must be a string.");
      if (input.content.trim() === "") return bad("content is empty. Write the document's content, or use delete_doc (organizer only) to remove a document.");
      let existing;
      try {
        existing = docs.get(input.path);
      } catch (e) {
        return bad(describeDocError(e, input.path));
      }
      const { text, note } = scrubbed(input.content);
      try {
        if (existing) {
          const known = readShas.get(input.path);
          if (!known) {
            return bad(
              `${input.path} already exists and you have not read it completely in this session. Read it with read_doc first, then write the merged result (or use edit_doc for a targeted change).`,
            );
          }
          if (existing.content === text) return ok(`No change: ${input.path} already has exactly this content.`);
          const res = docs.write(input.path, text, { expectSha256: known });
          readShas.set(input.path, res.sha256);
          stats.mutations++;
          return ok(`Updated ${input.path} (${byteLength(text)} bytes).${note}`);
        }
        const res = docs.write(input.path, text);
        readShas.set(input.path, res.sha256);
        stats.mutations++;
        return ok(`Created ${input.path} (${byteLength(text)} bytes).${note}`);
      } catch (e) {
        return bad(describeDocError(e, input.path));
      }
    },

    edit_doc(input) {
      for (const k of ["path", "old_string", "new_string"]) {
        if (typeof input[k] !== "string") return bad(`${k} must be a string.`);
      }
      if (input.old_string === "") return bad("old_string must not be empty.");
      let doc;
      try {
        doc = docs.get(input.path);
      } catch (e) {
        return bad(describeDocError(e, input.path));
      }
      if (!doc) return bad(`Not found: ${input.path} does not exist. Create it with write_doc.`);
      const first = doc.content.indexOf(input.old_string);
      if (first === -1) {
        return bad(`old_string was not found in ${input.path}. It must match the current content exactly, including whitespace and newlines. Re-read the document with read_doc and try again.`);
      }
      let matches = 1;
      for (let at = doc.content.indexOf(input.old_string, first + 1); at !== -1; at = doc.content.indexOf(input.old_string, at + 1)) matches++;
      if (matches > 1) {
        return bad(`old_string matches ${matches} places in ${input.path}. Include more surrounding text so that it matches exactly one place.`);
      }
      const candidate = doc.content.slice(0, first) + input.new_string + doc.content.slice(first + input.old_string.length);
      const { text, note } = scrubbed(candidate);
      if (text === doc.content) return ok(`No change: ${input.path} is already as requested.`);
      if (text.trim() === "") return bad("The edit would leave the document empty. Use delete_doc (organizer only) or keep some content.");
      try {
        const res = docs.write(input.path, text, { expectSha256: doc.sha256 });
        // The edit applied to the current content. The agent has only seen the whole
        // document if its earlier read matched that content.
        if (readShas.get(input.path) === doc.sha256) readShas.set(input.path, res.sha256);
        else readShas.delete(input.path);
        stats.mutations++;
        return ok(`Edited ${input.path} (${byteLength(text)} bytes).${note}`);
      } catch (e) {
        return bad(describeDocError(e, input.path));
      }
    },

    delete_doc(input) {
      if (typeof input.path !== "string") return bad("path must be a string.");
      try {
        docs.delete(input.path);
      } catch (e) {
        return bad(describeDocError(e, input.path));
      }
      readShas.delete(input.path);
      stats.mutations++;
      return ok(`Deleted ${input.path}.`);
    },

    rename_doc(input) {
      if (typeof input.from !== "string" || typeof input.to !== "string") return bad("from and to must be strings.");
      try {
        docs.rename(input.from, input.to);
      } catch (e) {
        return bad(describeDocError(e, e?.code === "conflict" ? input.to : input.from));
      }
      readShas.delete(input.from);
      readShas.delete(input.to);
      stats.mutations++;
      return ok(`Renamed ${input.from} to ${input.to}. Update [[links]] and ${INDEX_PATH} that referenced the old name.`);
    },

    submit(input) {
      if (typeof input.summary !== "string" || input.summary.trim() === "") return bad("summary must be a non-empty string.");
      const summary = clip(input.summary.trim(), 4_000);
      if (role === "organizer") {
        if (!Array.isArray(input.changes) || input.changes.some((c) => typeof c !== "string")) return bad("changes must be an array of strings.");
        if (docs.list().length > 0) {
          const index = docs.get(INDEX_PATH);
          if (!index) return bad(`${INDEX_PATH} does not exist. Write the index (one "[[slug]] - one sentence" line per document, grouped under ## domain headings), then submit.`);
          if (index.content.length > INDEX_MAX_CHARS && oversizeIndexRejections++ < 2) {
            return bad(
              `${INDEX_PATH} is ${index.content.length} characters; it is injected into every session and must stay under ${INDEX_MAX_CHARS}. Shorten entries, group or drop low-value ones, then submit again.`,
            );
          }
        }
        return {
          text: "Submitted.",
          isError: false,
          submission: { summary, changes: input.changes.slice(0, 100).map((c) => clip(c.trim(), 300)) },
        };
      }
      const touched = Array.isArray(input.touched) ? input.touched.filter((p) => typeof p === "string").slice(0, 100) : [];
      return { text: "Submitted.", isError: false, submission: { summary, touched } };
    },
  };

  return {
    definitions,
    /**
     * @returns {{text:string, isError:boolean, submission?:object}}
     */
    execute(name, input) {
      if (typeof name !== "string" || !allowed.has(name)) {
        return bad(`Unknown tool "${short(name, 64)}". Available tools: ${definitions.map((d) => d.name).join(", ")}. There is no shell, network or file access.`);
      }
      const args = input && typeof input === "object" && !Array.isArray(input) ? input : {};
      try {
        return handlers[name](args);
      } catch (e) {
        return bad(`Tool ${name} failed: ${e?.message ?? e}`);
      }
    },
  };
}
