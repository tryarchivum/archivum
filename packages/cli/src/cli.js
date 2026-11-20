import fs from "node:fs";
import { parseArgs, intFlag } from "./args.js";
import { CliError, UsageError } from "./errors.js";
import { Store, userHome, assertDocPath, isSafeId } from "./store.js";
import { scrubSecrets, newId } from "./core.js";
import { CLI_SOURCE, contextFor, formatResults, recallResults, rememberChecked } from "./memory.js";
import { normalizeEvents } from "./transcript.js";
import {
  applyProposal,
  formatHistory,
  pendingChanges,
  rejectProposal,
  renderProposalDiff,
  restorePath,
  runRetention,
} from "./proposals.js";

const VERSION = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

const USAGE = `archivum ${VERSION}: local-first memory for AI agents

Usage: archivum <command> [options]

Setup
  init [--claude-code] [--codex] [--hermes] [--cursor] [--claude-desktop] [--all] [--dry-run] [--home DIR] [--dir DIR] [--no-agents-md] [--prompt-recall]
  mcp                       run the MCP server on stdio
  hook session-start|user-prompt|stop   Claude Code hook (JSON on stdin)

Memory
  remember "text"           save a note
  recall "query" [--limit N] [--kind note|wiki] [--since DATE]
  context [--max-chars N]
  status
  log [--file F | -] [--source S] [--id ID]   store a transcript (JSON events)
  import omp [--dir D] [--session FILE] [--all] [--since DATE]   store omp sessions as transcripts

Dreaming
  dream [--budget TOKENS] [--instructions "..."] [--yes] [--dry-run] [--apply]
        [--since DATE] [--max-inputs N]   only transcripts updated since DATE; at most N (1-200, default 50)
  dream --if-due [--min-pending N] [--idle-minutes M] [--cooldown-hours H]   for schedulers: dream only when
        at least N (3) transcripts are pending, the newest is M (10) minutes old and the last dream H (6) hours old
  doctor [--json]           read-only health check (PASS/WARN/FAIL per line; exit 1 on FAIL)
  proposals
  diff [id]
  apply [id] [--only PATHS] [--force]   --only /a.md,/b.md applies just those pages; the rest stays under review
  reject [id]
  restore <path> [--version N]
  history [path]
  retention [--days N]

Global: --space NAME (default: $ARCHIVUM_SPACE or the current folder name), --help, --version
Environment: ARCHIVUM_HOME (default ~/.archivum), ARCHIVUM_LLM_PROVIDER, ARCHIVUM_LLM_API_KEY,
  ARCHIVUM_LLM_BASE_URL, ARCHIVUM_ANALYZER_MODEL, ARCHIVUM_ORGANIZER_MODEL
Exit codes: 0 ok, 1 runtime error, 2 usage or configuration error`;

const out = (s = "") => process.stdout.write(`${s}\n`);

const SPEC = {
  init: { bool: ["claude-code", "codex", "hermes", "cursor", "claude-desktop", "all", "dry-run", "no-agents-md", "prompt-recall"], string: ["home", "dir"] },
  mcp: { string: ["space"] },
  hook: { string: ["space"] },
  log: { string: ["file", "source", "id", "space"] },
  remember: { string: ["space"] },
  recall: { string: ["limit", "kind", "since", "space"] },
  context: { string: ["max-chars", "space"] },
  status: { string: ["space"] },
  dream: {
    bool: ["yes", "dry-run", "apply", "if-due"],
    string: ["budget", "instructions", "space", "since", "max-inputs", "min-pending", "idle-minutes", "cooldown-hours"],
    alias: { y: "yes" },
  },
  doctor: { bool: ["json"], string: ["space"] },
  proposals: { string: ["space"] },
  diff: { string: ["space"] },
  apply: { bool: ["force"], string: ["space", "only"] },
  reject: { string: ["space"] },
  restore: { string: ["version", "space"] },
  import: { bool: ["all"], string: ["dir", "session", "since", "space"] },
  history: { string: ["space"] },
  retention: { string: ["days", "space"] },
};

function readInput(file) {
  if (file === undefined || file === "-") return fs.readFileSync(0, "utf8");
  try {
    return fs.readFileSync(file, "utf8");
  } catch (e) {
    throw new UsageError(`Cannot read ${file}: ${e.code ?? e.message}`);
  }
}

function logCommand(store, flags) {
  let data;
  try {
    data = JSON.parse(readInput(flags.file));
  } catch (e) {
    if (e instanceof CliError) throw e;
    throw new UsageError("Input is not valid JSON.");
  }
  const events = normalizeEvents(Array.isArray(data) ? data : data?.events);
  const id = flags.id ?? newId("trn");
  if (!isSafeId(id)) throw new UsageError("--id may only contain letters, digits, _ . - (up to 128 characters).");
  const source = flags.source ?? (typeof data?.source === "string" ? data.source : "cli");
  const { transcript, changed } = store.upsertTranscript({ id, source, externalId: flags.id ?? null, events });
  out(changed ? `Logged transcript ${transcript.id} (${events.length} events, status ${transcript.status}).` : `Transcript ${transcript.id} unchanged.`);
}

function statusCommand(store) {
  const transcripts = store.listTranscripts();
  const proposals = store.listProposals();
  const wikiDocs = store.wikiCount();
  out(`Home:        ${store.root}`);
  out(`Space:       ${store.space}`);
  out(`Notes:       ${store.readNotes().length}`);
  out(`Wiki docs:   ${wikiDocs}`);
  out(`Transcripts: ${transcripts.filter((t) => t.status === "pending").length} pending, ${transcripts.filter((t) => t.status === "dreamed").length} dreamed`);
  out(`Proposals:   ${proposals.filter((p) => p.status === "review").length} awaiting review, ${proposals.length} total`);
}

function proposalsCommand(store) {
  const list = store.listProposals();
  if (list.length === 0) return out("No proposals. Run: archivum dream");
  for (const p of list) {
    let n = "?";
    try {
      n = String(pendingChanges(store, p.id).length);
    } catch {}
    out(`${p.id}  ${p.status.padEnd(8)}${p.partial ? " PARTIAL" : ""}  ${p.created_at}  ${p.status === "review" ? `${n} change(s)` : `${(p.applied_paths ?? []).length} applied`}`);
  }
}

async function dispatch(cmd, rest, env) {
  const spec = SPEC[cmd];
  if (!spec) throw new UsageError(`Unknown command "${cmd}". Run: archivum --help`);
  const { flags, positionals } = parseArgs(rest, spec);
  const openStore = () => Store.open({ space: flags.space, env });
  const one = (what) => {
    if (positionals.length > 1) throw new UsageError(`Too many arguments for ${what}.`);
    return positionals[0];
  };
  switch (cmd) {
    case "init": {
      const { initCommand } = await import("./init.js");
      return initCommand(flags, env, flags.home ?? userHome(env));
    }
    case "mcp": {
      const { mcpCommand } = await import("./mcp.js");
      return mcpCommand(openStore());
    }
    case "hook": {
      const sub = positionals[0];
      if (sub !== "session-start" && sub !== "user-prompt" && sub !== "stop") throw new UsageError("Usage: archivum hook session-start|user-prompt|stop");
      const { hookCommand } = await import("./hook.js");
      return hookCommand(sub, flags, env);
    }
    case "log":
      logCommand(openStore(), flags);
      return 0;
    case "import": {
      const { importCommand } = await import("./import.js");
      return importCommand(positionals, flags, env);
    }
    case "remember": {
      const r = rememberChecked(openStore(), positionals.join(" "), undefined, CLI_SOURCE);
      if (r.duplicateOf) out(`Already remembered as ${r.duplicateOf.id}; nothing saved.`);
      else {
        out(`Saved note ${r.note.id}.`);
        if (r.similarTo) out(`Note: very similar to ${r.similarTo.id} ("${r.similarTo.content.replace(/\s+/g, " ").slice(0, 80)}"). If it replaces it: archivum forget ${r.similarTo.id}`);
      }
      return 0;
    }
    case "recall": {
      if (positionals.length === 0) throw new UsageError('Usage: archivum recall "query" [--limit N]');
      const kind = flags.kind;
      if (kind !== undefined && kind !== "note" && kind !== "wiki") throw new UsageError("--kind must be note or wiki.");
      out(formatResults(recallResults(openStore(), positionals.join(" "), intFlag(flags, "limit", { max: 50, fallback: 5 }), { kind, since: flags.since })));
      return 0;
    }
    case "context": {
      const c = contextFor(openStore(), intFlag(flags, "max-chars", { min: 100, max: 100_000, fallback: 4096 }));
      if (c.content) out(c.content);
      else process.stderr.write("Memory is empty for this space.\n");
      return 0;
    }
    case "status":
      statusCommand(openStore());
      return 0;
    case "dream": {
      const { dreamCommand } = await import("./dream.js");
      return dreamCommand(openStore(), flags, env);
    }
    case "doctor": {
      const { doctorCommand } = await import("./doctor.js");
      return doctorCommand(openStore(), flags, env);
    }
    case "proposals":
      proposalsCommand(openStore());
      return 0;
    case "diff": {
      const store = openStore();
      out(renderProposalDiff(store, store.pickProposal(one("diff"))));
      return 0;
    }
    case "apply": {
      const store = openStore();
      const p = store.pickProposal(one("apply"));
      if (flags.only !== undefined && flags.only === true) throw new UsageError("--only needs paths, for example --only /deploys.md,/testing.md");
      const r = applyProposal(store, p, { force: Boolean(flags.force), only: flags.only });
      out(`Applied ${r.applied.length} path(s) from ${p.id}.`);
      for (const a of r.applied) out(`  wrote ${a}`);
      for (const s of r.skipped) out(`  skipped ${s.path}: ${s.reason}`);
      if (r.status !== "applied" && r.applied.length > 0) {
        out(`${r.remaining.length} page(s) still under review: ${r.remaining.join(", ")}`);
        out(`  archivum apply ${p.id} --only <path>   take another page`);
        out(`  archivum reject ${p.id}                 discard the rest (the pages already applied stay)`);
        return 0;
      }
      if (r.status !== "applied") {
        out("Nothing was applied and the proposal stays under review. Use --force to overwrite the changed live files, or run a new dream.");
        return 1;
      }
      const removed = runRetention(store);
      if (removed) out(`Retention: removed ${removed} old transcript(s).`);
      return 0;
    }
    case "reject": {
      const store = openStore();
      const p = store.pickProposal(one("reject"));
      const rj = rejectProposal(store, p);
      if (rj.kept.length > 0) out(`Rejected the remaining ${rj.rejected.length} page(s) of ${p.id}. The ${rj.kept.length} page(s) already applied stay, and its inputs are marked dreamed.`);
      else out(`Rejected ${p.id}. Its inputs stay pending.`);
      return 0;
    }
    case "restore": {
      const p = positionals[0];
      if (!p || positionals.length > 1) throw new UsageError("Usage: archivum restore <path> [--version N]");
      assertDocPath(p);
      const version = flags.version === undefined ? undefined : intFlag(flags, "version");
      const t = restorePath(openStore(), p, version);
      out(`Restored ${p} to version ${t.version} (${t.ts}).`);
      return 0;
    }
    case "history":
      out(formatHistory(openStore(), one("history")));
      return 0;
    case "retention": {
      const days = intFlag(flags, "days", { min: 0, fallback: 30 });
      const n = runRetention(openStore(), days);
      out(`Removed ${n} transcript(s) dreamed more than ${days} day(s) ago.`);
      return 0;
    }
    default:
      throw new UsageError(`Unknown command "${cmd}".`);
  }
}

// `archivum --space X dream` works like `archivum dream --space X`: leading global flags move behind the command.
function hoistGlobalFlags(argv) {
  const lead = [];
  let i = 0;
  while (i < argv.length && (argv[i] === "--space" || argv[i] === "--home") && i + 1 < argv.length) {
    lead.push(argv[i], argv[i + 1]);
    i += 2;
  }
  if (lead.length === 0 || i >= argv.length) return argv;
  return [argv[i], ...lead, ...argv.slice(i + 1)];
}

export async function main(rawArgv, env = process.env) {
  const [cmd, ...rest] = hoistGlobalFlags(rawArgv);
  if (cmd === undefined || cmd === "help" || cmd === "--help" || cmd === "-h") {
    out(USAGE);
    return cmd === undefined ? 2 : 0;
  }
  if (cmd === "--version" || cmd === "-v") {
    out(VERSION);
    return 0;
  }
  if (rest.includes("--help") || rest.includes("-h")) {
    out(USAGE);
    return 0;
  }
  try {
    return (await dispatch(cmd, rest, env)) ?? 0;
  } catch (e) {
    if (e instanceof CliError) {
      process.stderr.write(`archivum: ${e.message}\n`);
      // Hooks must never fail a session, not even for a mistyped sub-command (0.2.6 exited 2 here).
      return cmd === "hook" ? 0 : e.exitCode;
    }
    if (cmd === "hook") return 0;
    process.stderr.write(`archivum: ${env.ARCHIVUM_DEBUG === "1" ? (e?.stack ?? e) : (e?.message ?? e)}\n`);
    return 1;
  }
}

