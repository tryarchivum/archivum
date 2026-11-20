import { sha256Hex, diffDocs, lineDiff } from "./core.js";
import { CliError, UsageError } from "./errors.js";
import { assertDocPath } from "./store.js";

const DAY_MS = 86_400_000;

/**
 * Paths the proposal changes relative to the live wiki as it was when the proposal was cloned.
 * Each: {path, kind, before (live now), after (staged), baseSha, conflict, done}
 * `done` means the live file already equals the proposal (applied earlier, page by page, or edited by hand to the same text).
 */
export function proposalChanges(store, id) {
  const base = store.readBase(id);
  const staged = store.readProposalWiki(id);
  const paths = new Set([...Object.keys(base), ...Object.keys(staged)]);
  const out = [];
  for (const p of [...paths].sort()) {
    const baseSha = base[p] ?? null;
    const after = staged[p] ?? null;
    const afterSha = after === null ? null : sha256Hex(after);
    if (afterSha === baseSha) continue;
    const before = store.readDoc(p);
    const liveSha = before === null ? null : sha256Hex(before);
    const done = liveSha === afterSha;
    out.push({
      path: p,
      kind: after === null ? "removed" : baseSha === null ? "added" : "modified",
      before,
      after,
      baseSha,
      conflict: !done && liveSha !== baseSha,
      done,
    });
  }
  return out;
}

/** The changes still waiting to be applied. */
export const pendingChanges = (store, id) => proposalChanges(store, id).filter((c) => !c.done);

/** Accepts "/a.md,/b.md", "a.md" or an array; returns normalised doc paths. */
export function parseOnly(value) {
  const parts = (Array.isArray(value) ? value : String(value ?? "").split(","))
    .flatMap((v) => String(v).split(","))
    .map((v) => v.trim())
    .filter(Boolean)
    .map((v) => (v.startsWith("/") ? v : `/${v}`));
  return [...new Set(parts)];
}

const splitLines = (s) => {
  const lines = s.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
};

/** Plain unified-style diff of one document (no colours). */
export function unifiedDiff(p, before, after, ctx = 3) {
  const header = [`--- ${before === null ? "/dev/null" : `live${p}`}`, `+++ ${after === null ? "/dev/null" : `proposed${p}`}`];
  let ops;
  if (before === null) ops = splitLines(after).map((text) => ({ type: "add", text }));
  else if (after === null) ops = splitLines(before).map((text) => ({ type: "del", text }));
  else {
    ops = lineDiff(before, after);
    while (ops.length && ops.at(-1).type === "same" && ops.at(-1).text === "") ops = ops.slice(0, -1);
  }
  let o = 1;
  let n = 1;
  const pos = ops.map((op) => {
    const r = { o, n };
    if (op.type !== "add") o++;
    if (op.type !== "del") n++;
    return r;
  });
  const changed = [];
  ops.forEach((op, i) => op.type !== "same" && changed.push(i));
  if (changed.length === 0) return [...header, "(no line changes)"].join("\n");
  const ranges = [];
  for (const i of changed) {
    const s = Math.max(0, i - ctx);
    const e = Math.min(ops.length - 1, i + ctx);
    const last = ranges.at(-1);
    if (last && s <= last[1] + 1) last[1] = Math.max(last[1], e);
    else ranges.push([s, e]);
  }
  const lines = [...header];
  for (const [s, e] of ranges) {
    const slice = ops.slice(s, e + 1);
    const oc = slice.filter((x) => x.type !== "add").length;
    const nc = slice.filter((x) => x.type !== "del").length;
    lines.push(`@@ -${oc === 0 ? pos[s].o - 1 : pos[s].o},${oc} +${nc === 0 ? pos[s].n - 1 : pos[s].n},${nc} @@`);
    for (const x of slice) lines.push(`${x.type === "add" ? "+" : x.type === "del" ? "-" : " "}${x.text}`);
  }
  return lines.join("\n");
}

export function renderProposalDiff(store, proposal) {
  const changes = proposalChanges(store, proposal.id);
  if (changes.length === 0) return `Proposal ${proposal.id} has no changes.`;
  // Cross-check with core's snapshot diff so both views agree on kinds.
  const core = new Map(
    diffDocs(
      Object.fromEntries(changes.filter((c) => c.before !== null).map((c) => [c.path, c.before])),
      Object.fromEntries(changes.filter((c) => c.after !== null).map((c) => [c.path, c.after])),
    ).map((d) => [d.path, d.kind]),
  );
  return changes
    .map((c) => {
      const kind = core.get(c.path) ?? c.kind;
      if (c.done) return `=== ${c.path} (${kind})  [already applied]`;
      const note = c.conflict ? "  [live file changed since this proposal was made; apply skips it unless --force]" : "";
      return `=== ${c.path} (${kind})${note}\n${unifiedDiff(c.path, c.before, c.after)}`;
    })
    .join("\n\n");
}

/**
 * Write a proposal's changes to the live wiki.
 * A path is applied only when live still equals the base (unless force). Returns {applied, skipped}.
 */
export function applyProposal(store, proposal, { force = false, only } = {}) {
  if (proposal.status === "applied") throw new CliError(`Proposal ${proposal.id} was already applied.`);
  if (proposal.status === "rejected") throw new CliError(`Proposal ${proposal.id} was rejected.`);
  const actor = `dream:${proposal.id}`;
  const pending = pendingChanges(store, proposal.id);
  const wanted = only === undefined ? null : parseOnly(only);
  if (wanted !== null) {
    if (wanted.length === 0) throw new UsageError("--only needs at least one path, for example --only /deploys.md,/testing.md");
    const known = new Set(pending.map((c) => c.path));
    const unknown = wanted.filter((p) => !known.has(p));
    if (unknown.length > 0) {
      throw new CliError(`${unknown.join(", ")} ${unknown.length > 1 ? "are" : "is"} not a pending change of ${proposal.id}. Pending: ${pending.map((c) => c.path).join(", ") || "(none)"}.`);
    }
  }
  const targets = wanted === null ? pending : pending.filter((c) => wanted.includes(c.path));
  const applied = [];
  const skipped = [];
  for (const c of targets) {
    if (c.conflict && !force) {
      skipped.push({ path: c.path, reason: "live file changed since the proposal was made" });
      continue;
    }
    if (c.after === null) store.deleteDoc(c.path, { actor });
    else store.writeDoc(c.path, c.after, { actor });
    applied.push(c.path);
  }
  const everApplied = [...new Set([...(proposal.applied_paths ?? []), ...applied])];
  const next = { ...proposal, applied_paths: everApplied, skipped_paths: skipped };
  const remaining = pending.filter((c) => !applied.includes(c.path)).map((c) => c.path);
  // Page by page: some pages are still waiting. Stay in review; the inputs are consumed when the proposal is finished.
  if (wanted !== null && remaining.length > 0) {
    store.writeProposal(next);
    return { applied, skipped, status: proposal.status, remaining };
  }
  if (applied.length === 0 && skipped.length > 0) {
    store.writeProposal(next);
    return { applied, skipped, status: proposal.status, remaining };
  }
  consumeInputs(store, proposal);
  next.status = "applied";
  next.applied_at = new Date().toISOString();
  store.writeProposal(next);
  return { applied, skipped, status: "applied", remaining: [] };
}

/** Mark the proposal's inputs as dreamed and advance the notes watermark. */
export function consumeInputs(store, proposal) {
  const ts = new Date().toISOString();
  const seen = proposal.transcript_versions ?? {};
  for (const id of proposal.transcripts ?? []) {
    const t = store.getTranscript(id);
    if (!t) continue;
    if (seen[id] && t.updated_at !== seen[id]) continue; // changed since the dream read it
    store.saveTranscript({ ...t, status: "dreamed", dreamed_at: ts });
  }
  if (proposal.notes_through) {
    const state = store.readState();
    if (!state.notes_consolidated_through || state.notes_consolidated_through < proposal.notes_through) {
      store.writeState({ ...state, notes_consolidated_through: proposal.notes_through });
    }
  }
}

/**
 * Reject a proposal. When some pages were already applied, only the rest is rejected: the applied pages stay in the wiki and
 * the inputs are marked dreamed, because part of this dream was accepted. Returns {rejected, kept}.
 */
export function rejectProposal(store, proposal) {
  if (proposal.status !== "review") throw new CliError(`Proposal ${proposal.id} is ${proposal.status}, not under review.`);
  const kept = proposal.applied_paths ?? [];
  const rejected = pendingChanges(store, proposal.id).map((c) => c.path);
  if (kept.length > 0) consumeInputs(store, proposal);
  store.writeProposal({ ...proposal, status: "rejected", rejected_at: new Date().toISOString(), rejected_paths: rejected });
  return { rejected, kept };
}

/** Restore a path to a previous version. Returns the history entry. */
export function restorePath(store, p, version) {
  assertDocPath(p);
  const versions = store.versionsOf(p);
  if (versions.length === 0) throw new CliError(`No history for ${p}.`);
  const current = store.readDoc(p);
  let target;
  if (version !== undefined) {
    target = versions.find((v) => v.version === version);
    if (!target) throw new CliError(`${p} has no version ${version} (versions: 1-${versions.length}).`);
    if (!target.file) throw new CliError(`Version ${version} of ${p} is a deletion; pick a version that has content.`);
  } else {
    const curSha = current === null ? null : sha256Hex(current);
    target = [...versions].reverse().find((v) => v.file && v.sha256 !== curSha);
    if (!target) throw new CliError(`${p} has no earlier version to restore.`);
  }
  const content = store.readSnapshotFile(target.file);
  if (content === null) throw new CliError(`The snapshot file for ${p} version ${target.version} is missing.`);
  if (content === current) throw new CliError(`${p} already matches version ${target.version}.`);
  store.writeDoc(p, content, { actor: "restore", operation: "restore" });
  return target;
}

export function formatHistory(store, p) {
  let entries;
  if (p) {
    assertDocPath(p);
    entries = store.versionsOf(p);
  } else {
    const seen = new Map();
    entries = store.readHistory().map((e) => {
      const v = (seen.get(e.path) ?? 0) + 1;
      seen.set(e.path, v);
      return { ...e, version: v };
    });
  }
  if (entries.length === 0) return p ? `No history for ${p}.` : "No history yet.";
  return entries
    .map((e) => `${p ? "" : `${e.path} `}v${e.version}  ${e.ts}  ${e.operation.padEnd(7)} ${e.actor}${e.sha256 ? `  ${e.sha256.slice(0, 8)}` : ""}`)
    .join("\n");
}

/** Delete transcripts dreamed more than `days` days ago. Returns the number removed. */
export function runRetention(store, days = 30, now = Date.now()) {
  if (!Number.isFinite(days) || days < 0) throw new UsageError("--days must be a non-negative number");
  let removed = 0;
  for (const t of store.listTranscripts()) {
    if (t.status !== "dreamed" || !t.dreamed_at) continue;
    const at = Date.parse(t.dreamed_at);
    if (Number.isFinite(at) && now - at > days * DAY_MS) {
      store.deleteTranscript(t.id);
      removed++;
    }
  }
  return removed;
}
