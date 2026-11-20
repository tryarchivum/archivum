import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { archivumRoot, userHome, isSafeId } from "./store.js";
import { findBinary } from "./init.js";

const out = (s = "") => process.stdout.write(`${s}\n`);

const check = (name, status, detail, hint = "") => ({ name, status, detail, hint });

function checkNode() {
  const major = Number(process.versions.node.split(".")[0]);
  return major >= 22
    ? check("node", "PASS", `Node ${process.versions.node}`, "")
    : check("node", "FAIL", `Node ${process.versions.node} is too old`, "Install Node 22 or newer.");
}

function checkHome(env) {
  const root = archivumRoot(env);
  let probe = root;
  while (!fs.existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  const exists = probe === root;
  try {
    if (!fs.statSync(probe).isDirectory()) throw new Error("not a directory");
    fs.accessSync(probe, fs.constants.W_OK);
  } catch {
    return check("home", "FAIL", `${root} ${exists ? "is not a writable directory" : `cannot be created (${probe} is not a writable directory)`}`, "Set ARCHIVUM_HOME to a writable folder or fix its permissions.");
  }
  return check("home", "PASS", exists ? `${root} exists and is writable` : `${root} does not exist yet but can be created`, exists ? "" : "It is created on first use.");
}

/** Parses every file of the space. Reports how many could not be read; never writes. */
function checkSpaceFiles(store) {
  if (!fs.existsSync(store.dir)) return check("space files", "PASS", `space "${store.space}" has no data yet`, "Run: archivum remember \"...\" or archivum log.");
  let total = 0;
  const bad = [];
  const tryJson = (file, validate) => {
    total++;
    try {
      const v = JSON.parse(fs.readFileSync(file, "utf8"));
      if (validate && !validate(v)) throw new Error("unexpected shape");
    } catch {
      bad.push(path.relative(store.dir, file));
    }
  };
  const tryLines = (file) => {
    let text;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch (e) {
      if (e.code === "ENOENT") return;
      total++;
      bad.push(path.relative(store.dir, file));
      return;
    }
    let n = 0;
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      n++;
      total++;
      try {
        JSON.parse(line);
      } catch {
        bad.push(`${path.relative(store.dir, file)} line ${n}`);
      }
    }
  };
  const list = (dir) => {
    try {
      return fs.readdirSync(dir);
    } catch {
      return [];
    }
  };
  for (const n of list(store.transcriptsDir)) {
    if (n.endsWith(".json")) tryJson(path.join(store.transcriptsDir, n), (t) => t && typeof t.id === "string" && Array.isArray(t.events));
  }
  tryLines(store.notesFile);
  if (fs.existsSync(store.stateFile)) tryJson(store.stateFile, (s) => s && typeof s === "object" && !Array.isArray(s));
  tryLines(store.historyLog);
  for (const n of list(store.proposalsDir)) {
    const f = path.join(store.proposalsDir, n, "proposal.json");
    if (isSafeId(n) && fs.existsSync(f)) tryJson(f, (p) => p && typeof p === "object" && !Array.isArray(p));
  }
  if (bad.length === 0) return check("space files", "PASS", `${total} file(s)/record(s) parse cleanly in space "${store.space}"`, "");
  const shown = bad.slice(0, 5).join(", ") + (bad.length > 5 ? `, and ${bad.length - 5} more` : "");
  return check("space files", "FAIL", `${bad.length} unreadable of ${total} in space "${store.space}": ${shown}`, "Restore the file from a backup or delete it; archivum skips unreadable records but cannot repair them.");
}

function hasHook(entries, marker) {
  return Array.isArray(entries) && entries.some((e) => e && Array.isArray(e.hooks) && e.hooks.some((h) => h && typeof h.command === "string" && marker.test(h.command)));
}

function checkClaudeHooks(env) {
  const dir = path.join(userHome(env), ".claude");
  if (!fs.existsSync(dir)) return check("claude hooks", "PASS", "~/.claude not found; Claude Code not in use", "Run `archivum init --claude-code` if you use Claude Code.");
  const file = path.join(dir, "settings.json");
  let settings;
  try {
    settings = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    const missing = e.code === "ENOENT";
    return check("claude hooks", "WARN", missing ? `${file} does not exist` : `${file} is not valid JSON`, missing ? "Run: archivum init --claude-code" : "Fix the JSON by hand, then run: archivum init --claude-code");
  }
  const hooks = settings && typeof settings === "object" ? settings.hooks : undefined;
  const missing = ["SessionStart", "Stop"].filter((ev) => !hasHook(hooks?.[ev], /archivum(s|-cli)? hook/));
  if (missing.length === 0) return check("claude hooks", "PASS", "SessionStart and Stop hooks call `archivum hook`", "");
  return check("claude hooks", "WARN", `missing ${missing.join(" and ")} hook(s) in ${file}`, "Run: archivum init --claude-code");
}

function checkMcp(bin, env) {
  const name = `mcp (${bin})`;
  const found = findBinary(bin, env);
  if (!found) return check(name, "PASS", `\`${bin}\` not found on PATH; skipped`, "");
  const r = spawnSync(bin, ["mcp", "list"], { encoding: "utf8", env, shell: process.platform === "win32", timeout: 5000 });
  const hint = `Register it: ${bin} mcp add archivum -- npx -y archivums mcp (or run: archivum init)`;
  if (r.error || r.status !== 0) {
    const why = r.error?.code === "ETIMEDOUT" ? "timed out after 5 s" : r.error ? r.error.message : `exit ${r.status}`;
    return check(name, "WARN", `\`${bin} mcp list\` failed (${why})`, hint);
  }
  return /archivum/i.test(`${r.stdout}${r.stderr}`)
    ? check(name, "PASS", `archivum is registered in ${bin}`, "")
    : check(name, "WARN", `archivum is not listed by \`${bin} mcp list\``, hint);
}

/** Configuration sanity only. No network call, and the key value is never printed. */
function checkLlm(env) {
  const provider = (env.ARCHIVUM_LLM_PROVIDER || "anthropic").toLowerCase();
  if (provider !== "anthropic" && provider !== "openai") {
    return check("llm config", "FAIL", `ARCHIVUM_LLM_PROVIDER "${provider}" is not valid`, 'Use "anthropic" or "openai".');
  }
  const key = env.ARCHIVUM_LLM_API_KEY || (provider === "anthropic" ? env.ANTHROPIC_API_KEY : env.OPENAI_API_KEY);
  const parts = [`provider ${provider}`, `api key ${key ? "set" : "missing"}`];
  const problems = [];
  if (!key) problems.push(`Set ARCHIVUM_LLM_API_KEY (or ${provider === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY"}).`);
  if (env.ARCHIVUM_LLM_BASE_URL) parts.push("base URL set");
  else if (provider === "openai") parts.push("base URL default http://localhost:20128/v1");
  else parts.push("base URL default (Anthropic API)");
  const fallback = provider === "anthropic" ? "claude-haiku-5-5" : undefined;
  const analyzer = env.ARCHIVUM_ANALYZER_MODEL || fallback;
  const organizer = env.ARCHIVUM_ORGANIZER_MODEL || fallback;
  parts.push(`analyzer model ${analyzer ?? "missing"}${!env.ARCHIVUM_ANALYZER_MODEL && fallback ? " (default)" : ""}`);
  parts.push(`organizer model ${organizer ?? "missing"}${!env.ARCHIVUM_ORGANIZER_MODEL && fallback ? " (default)" : ""}`);
  if (!analyzer) problems.push("Set ARCHIVUM_ANALYZER_MODEL.");
  if (!organizer) problems.push("Set ARCHIVUM_ORGANIZER_MODEL.");
  return problems.length === 0
    ? check("llm config", "PASS", parts.join("; "), "Not tested against the network.")
    : check("llm config", "WARN", parts.join("; "), `${problems.join(" ")} Needed only for \`archivum dream\`.`);
}

function checkPending(store) {
  let pendingTranscripts = 0;
  let review = 0;
  try {
    pendingTranscripts = store.listTranscripts().filter((t) => t.status === "pending" && t.events.length > 0).length;
    review = store.listProposals().filter((p) => p.status === "review").length;
  } catch {}
  const hint = review > 0 ? "Run: archivum proposals, then archivum diff / apply / reject." : pendingTranscripts > 0 ? "Run: archivum dream" : "";
  return check("pending work", "PASS", `${pendingTranscripts} pending transcript(s), ${review} proposal(s) awaiting review`, hint);
}

export function runChecks(store, env) {
  return [checkNode(), checkHome(env), checkSpaceFiles(store), checkClaudeHooks(env), checkMcp("claude", env), checkMcp("codex", env), checkLlm(env), checkPending(store)];
}

/** archivum doctor [--space S] [--json]. Read-only. Exit 0 unless a check FAILs. */
export function doctorCommand(store, flags, env) {
  const results = runChecks(store, env);
  const failed = results.some((r) => r.status === "FAIL");
  if (flags.json) {
    out(JSON.stringify(results, null, 2));
  } else {
    out(`archivum doctor (space "${store.space}")`);
    for (const r of results) {
      out(`${r.status.padEnd(4)}  ${r.name}: ${r.detail}`);
      if (r.hint) out(`      hint: ${r.hint}`);
    }
    const warn = results.filter((r) => r.status === "WARN").length;
    out(failed ? "Result: FAIL" : warn > 0 ? `Result: OK with ${warn} warning(s)` : "Result: OK");
  }
  return failed ? 1 : 0;
}
