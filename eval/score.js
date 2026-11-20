// Pure scoring functions for the dreaming evaluation. No I/O, no network.
//
// scoreDocs(docsMap, expected)   -> { passed:[id], failed:[{id,description,detail}], score, total }
// answerQuestions(questions, ask, contextText) -> Promise<{ correct, total, accuracy, stale_exposed, stale_total, stale_exposure, mean_context_chars, results }>
// contextStats(question, context) / summarizeStats(rows) -> context size and stale exposure (see below)
//
// `docsMap` is a plain object or a Map of absolute path ("/_index.md") -> content string.

/** Optional extra QA context modes a scenario may enable with `extra_modes` in expected.json. */
export const EXTRA_MODES = ["notes-top-10"];

export const CHECK_TYPES = [
  "present",
  "absent",
  "absent_unless_marked",
  "max_lines",
  "index_complete",
  "no_dangling_links",
  "max_doc_bytes",
  "doc_count",
  "paths_present",
];

// Lines around a flagged line that may carry the staleness marker (plus the nearest heading above it).
const MARKER_WINDOW = 3;

const encoder = new TextEncoder();

function normalizeDocs(docs) {
  const entries = docs instanceof Map ? [...docs] : Object.entries(docs ?? {});
  return entries
    .map(([path, content]) => [path, String(content ?? "").replace(/\r\n/g, "\n")])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

function compile(pattern, flags) {
  const f = (flags ?? "i").replace(/[gy]/g, "");
  return new RegExp(pattern, f);
}

function snippet(text, max = 60) {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max)}...` : one;
}

export function parseFrontmatter(content) {
  const m = /^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(content);
  if (!m) return { meta: {}, body: content };
  const meta = {};
  for (const line of m[1].split("\n")) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (kv) meta[kv[1]] = kv[2].trim();
  }
  return { meta, body: content.slice(m[0].length) };
}

function stripCode(text) {
  return text.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
}

export function extractLinks(content) {
  const out = [];
  const re = /\[\[([^\[\]\n]+?)\]\]/g;
  let m;
  const text = stripCode(content);
  while ((m = re.exec(text))) {
    const target = m[1].split("|")[0].split("#")[0].trim();
    if (target) out.push(target);
  }
  return out;
}

// All keys a [[link]] may use to address a document: basename slug, path without extension, frontmatter name.
function linkKeys(path, content) {
  const keys = new Set();
  const noExt = path.replace(/^\//, "").replace(/\.md$/i, "");
  keys.add(noExt.toLowerCase());
  keys.add(noExt.split("/").pop().toLowerCase());
  const { meta } = parseFrontmatter(content);
  if (meta.name) keys.add(meta.name.toLowerCase());
  return keys;
}

function buildLinkResolver(entries) {
  const byKey = new Map();
  for (const [path, content] of entries) {
    for (const key of linkKeys(path, content)) {
      if (!byKey.has(key)) byKey.set(key, new Set());
      byKey.get(key).add(path);
    }
  }
  return (target) => byKey.get(target.toLowerCase().replace(/\.md$/, "").replace(/^\//, "")) ?? new Set();
}

function runCheck(check, entries) {
  switch (check.type) {
    case "present": {
      const re = compile(check.pattern, check.flags);
      const hit = entries.find(([, c]) => re.test(c));
      return hit ? null : `no document matches /${check.pattern}/`;
    }
    case "absent": {
      const re = compile(check.pattern, check.flags);
      const hits = [];
      for (const [path, c] of entries) {
        const m = re.exec(c);
        if (m) hits.push(`${path}: "${snippet(m[0])}"`);
      }
      return hits.length ? `found in ${hits.join("; ")}` : null;
    }
    case "absent_unless_marked": {
      const re = compile(check.pattern, check.flags);
      const marker = compile(check.marker, check.flags);
      const bad = [];
      for (const [path, c] of entries) {
        const lines = c.split("\n");
        lines.forEach((line, i) => {
          if (!re.test(line)) return;
          const window = lines.slice(Math.max(0, i - MARKER_WINDOW), i + MARKER_WINDOW + 1).join("\n");
          if (marker.test(window)) return;
          for (let j = i; j >= 0; j--) {
            if (/^#{1,6}\s/.test(lines[j])) {
              if (marker.test(lines[j])) return;
              break;
            }
          }
          bad.push(`${path}:${i + 1}: "${snippet(line)}"`);
        });
      }
      return bad.length ? `unmarked occurrence(s): ${bad.join("; ")}` : null;
    }
    case "max_lines": {
      const re = compile(check.pattern, check.flags);
      let n = 0;
      for (const [, c] of entries) for (const line of c.split("\n")) if (re.test(line)) n++;
      return n > check.max ? `${n} lines match /${check.pattern}/ (max ${check.max})` : null;
    }
    case "index_complete": {
      const indexPath = check.index ?? "/_index.md";
      const index = entries.find(([p]) => p === indexPath);
      if (!index) return `${indexPath} does not exist`;
      const resolve = buildLinkResolver(entries);
      const listed = new Set();
      for (const target of extractLinks(index[1])) for (const p of resolve(target)) listed.add(p);
      const minBody = check.minBodyChars ?? 40;
      const missing = entries
        .filter(([p, c]) => p !== indexPath && parseFrontmatter(c).body.trim().length >= minBody)
        .map(([p]) => p)
        .filter((p) => !listed.has(p));
      return missing.length ? `not listed in ${indexPath}: ${missing.join(", ")}` : null;
    }
    case "no_dangling_links": {
      const resolve = buildLinkResolver(entries);
      const dangling = [];
      for (const [path, c] of entries) {
        for (const target of extractLinks(c)) if (resolve(target).size === 0) dangling.push(`${path} -> [[${target}]]`);
      }
      return dangling.length ? `dangling: ${dangling.join("; ")}` : null;
    }
    case "max_doc_bytes": {
      const over = entries
        .map(([p, c]) => [p, encoder.encode(c).length])
        .filter(([, n]) => n > check.max)
        .map(([p, n]) => `${p} (${n} bytes)`);
      return over.length ? `over ${check.max} bytes: ${over.join(", ")}` : null;
    }
    case "paths_present": {
      const have = new Set(entries.map(([p]) => p));
      const missing = check.paths.filter((p) => !have.has(p));
      return missing.length ? `missing document(s): ${missing.join(", ")}` : null;
    }
    case "doc_count": {
      const n = entries.length;
      if (check.min != null && n < check.min) return `${n} documents (min ${check.min})`;
      if (check.max != null && n > check.max) return `${n} documents (max ${check.max})`;
      return null;
    }
    default:
      throw new Error(`unknown check type "${check.type}" (check ${check.id})`);
  }
}

/** Returns a list of human-readable problems with an expected.json object (empty = well formed). */
export function validateExpected(expected) {
  const errors = [];
  if (!expected || typeof expected !== "object") return ["expected must be an object"];
  if (!Array.isArray(expected.checks) || expected.checks.length === 0) errors.push("checks must be a non-empty array");
  if (expected.instructions != null && (typeof expected.instructions !== "string" || !expected.instructions.trim())) errors.push("instructions must be a non-empty string when present");
  const ids = new Set();
  for (const [i, c] of (expected.checks ?? []).entries()) {
    const where = `checks[${i}]`;
    if (!c || typeof c !== "object") {
      errors.push(`${where} must be an object`);
      continue;
    }
    if (typeof c.id !== "string" || !c.id) errors.push(`${where}.id missing`);
    else if (ids.has(c.id)) errors.push(`${where}.id "${c.id}" duplicated`);
    else ids.add(c.id);
    if (typeof c.description !== "string" || !c.description) errors.push(`${where}.description missing`);
    if (!CHECK_TYPES.includes(c.type)) {
      errors.push(`${where}.type "${c.type}" unknown`);
      continue;
    }
    const regexFields =
      c.type === "present" || c.type === "absent" || c.type === "max_lines"
        ? ["pattern"]
        : c.type === "absent_unless_marked"
          ? ["pattern", "marker"]
          : [];
    for (const f of regexFields) {
      if (typeof c[f] !== "string" || !c[f]) {
        errors.push(`${where}.${f} must be a non-empty string`);
        continue;
      }
      try {
        compile(c[f], c.flags);
      } catch (e) {
        errors.push(`${where}.${f} is not a valid regex: ${e.message}`);
      }
    }
    if (c.type === "max_lines" && !Number.isInteger(c.max)) errors.push(`${where}.max must be an integer`);
    if (c.type === "max_doc_bytes" && !Number.isInteger(c.max)) errors.push(`${where}.max must be an integer`);
    if (c.type === "doc_count" && c.min == null && c.max == null) errors.push(`${where} needs min and/or max`);
    if (c.type === "paths_present" && (!Array.isArray(c.paths) || c.paths.length === 0 || c.paths.some((p) => typeof p !== "string" || !p.startsWith("/")))) {
      errors.push(`${where}.paths must be a non-empty array of absolute document paths`);
    }
  }
  if (expected.extra_modes != null) {
    if (!Array.isArray(expected.extra_modes) || expected.extra_modes.some((m) => !EXTRA_MODES.includes(m))) errors.push(`extra_modes must be an array of: ${EXTRA_MODES.join(", ")}`);
  }
  if (expected.dream_cost_gate != null && typeof expected.dream_cost_gate !== "boolean") errors.push("dream_cost_gate must be a boolean when present");
  if (!Array.isArray(expected.questions)) errors.push("questions must be an array");
  const qids = new Set();
  for (const [i, q] of (expected.questions ?? []).entries()) {
    const where = `questions[${i}]`;
    if (typeof q?.id !== "string" || !q.id) errors.push(`${where}.id missing`);
    else if (qids.has(q.id)) errors.push(`${where}.id "${q.id}" duplicated`);
    else qids.add(q.id);
    if (typeof q?.question !== "string" || !q.question) errors.push(`${where}.question missing`);
    for (const f of ["answer", "reject"]) {
      if (f === "reject" && q?.reject == null) continue;
      if (typeof q?.[f] !== "string" || !q[f]) {
        errors.push(`${where}.${f} must be a non-empty string`);
        continue;
      }
      try {
        compile(q[f], q.flags);
      } catch (e) {
        errors.push(`${where}.${f} is not a valid regex: ${e.message}`);
      }
    }
  }
  return errors;
}

export function scoreDocs(docsMap, expected) {
  const problems = validateExpected(expected);
  if (problems.length) throw new Error(`invalid expected.json: ${problems.join("; ")}`);
  const entries = normalizeDocs(docsMap);
  const passed = [];
  const failed = [];
  for (const check of expected.checks) {
    const detail = runCheck(check, entries);
    if (detail === null) passed.push(check.id);
    else failed.push({ id: check.id, description: check.description, detail });
  }
  const total = expected.checks.length;
  return { passed, failed, score: total ? passed.length / total : 0, total };
}

/** Render a docs map as the plain-text context handed to the QA model. */
export function renderContext(docsMap) {
  return normalizeDocs(docsMap)
    .map(([path, content]) => `=== ${path} ===\n${content.trimEnd()}`)
    .join("\n\n");
}

export function scoreAnswer(question, answer) {
  const text = String(answer ?? "");
  if (!compile(question.answer, question.flags).test(text)) return false;
  if (question.reject && compile(question.reject, question.flags).test(text)) return false;
  return true;
}

/**
 * What a retrieved context exposes to the model, independent of what the model answers:
 *  chars  its length in characters;
 *  stale  whether it contains a value the question's `reject` regex names (a superseded value, or for leak questions the
 *         forbidden value), even if the answer ends up right. null when the question has no `reject`.
 */
export function contextStats(question, context) {
  const text = String(context ?? "");
  return { chars: text.length, stale: question.reject ? compile(question.reject, question.flags).test(text) : null };
}

/**
 * Aggregates `{chars, stale}` rows (one per question) of one context mode:
 *  stale_exposed / stale_total / stale_exposure  over the questions that have a `reject` regex (null rate when there are none);
 *  mean_context_chars                            over all questions.
 */
export function summarizeStats(rows) {
  const rejectable = rows.filter((r) => r.stale !== null);
  const exposed = rejectable.filter((r) => r.stale).length;
  return {
    stale_exposed: exposed,
    stale_total: rejectable.length,
    stale_exposure: rejectable.length ? exposed / rejectable.length : null,
    mean_context_chars: rows.length ? rows.reduce((n, r) => n + r.chars, 0) / rows.length : 0,
  };
}

/**
 * Ask every question with a context and score the answers by regex. `contextText` is a string (same context for every
 * question) or a function `(question, questionObject) => string` (per-question retrieval, used by the QA baselines).
 * `ask(question, contextText)` may be sync or async and returns the answer text.
 * Errors from `ask` propagate: a failed API call must not silently count as a wrong answer.
 * Besides accuracy the result carries the context metrics of contextStats / summarizeStats.
 */
export async function answerQuestions(questions, ask, contextText) {
  const results = [];
  for (const q of questions) {
    const ctx = typeof contextText === "function" ? contextText(q.question, q) : contextText;
    const answer = String(await ask(q.question, ctx));
    const { chars, stale } = contextStats(q, ctx);
    results.push({ id: q.id, question: q.question, answer, ok: scoreAnswer(q, answer), context_chars: chars, stale });
  }
  const correct = results.filter((r) => r.ok).length;
  return {
    correct,
    total: results.length,
    accuracy: results.length ? correct / results.length : 0,
    ...summarizeStats(results.map((r) => ({ chars: r.context_chars, stale: r.stale }))),
    results,
  };
}
