import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { CliError } from "./errors.js";
import { atomicWrite } from "./store.js";
import { setupAgentsMd } from "./agents-md.js";

const HOOKS = [
  ["SessionStart", "npx -y archivums hook session-start", /archivum(s|-cli)? hook session-start/],
  ["Stop", "npx -y archivums hook stop", /archivum(s|-cli)? hook stop/],
];
// The prompt hook runs before EVERY prompt, so it must not go through npx: measured 2.7-4.4 s per call with npx against 0.2 s
// with the installed command. It also must be the same version that ran `init` (an older one exits 2 on this sub-command,
// and exit 2 on UserPromptSubmit blocks the prompt). So it needs `archivum` on PATH, and init refuses without it.
const PROMPT_HOOK = ["UserPromptSubmit", "archivum hook user-prompt", /archivum(s|-cli)? hook user-prompt/];
/**
 * How a terminal client should start the server. The installed command starts in 0.3 s; `npx -y archivums` took 2.8-3.7 s per start
 * when measured, and a client that waits for the server at the first message can time out. On Windows a global npm command is a
 * .cmd shim, which only starts through `cmd /c` (this form has not been run on a real Windows client yet).
 */
export function mcpLaunch(env = process.env) {
  if (findBinary("archivum", env, { installed: true }) === null) return ["npx", "-y", "archivums", "mcp"];
  return process.platform === "win32" ? ["cmd", "/c", "archivum", "mcp"] : ["archivum", "mcp"];
}
const mcpAddArgs = (env) => ["mcp", "add", "archivum", "--", ...mcpLaunch(env)];
const MCP_COMMAND = (bin, env) => `${bin} ${mcpAddArgs(env).join(" ")}`;
const codexToml = (env) => {
  const [command, ...args] = mcpLaunch(env);
  return `[mcp_servers.archivum]\ncommand = "${command}"\nargs = [${args.map((a) => `"${a}"`).join(", ")}]`;
};

const out = (s = "") => process.stdout.write(`${s}\n`);

/** A PATH entry that exists only while a package runner is running: npx puts <cache>/_npx/<hash>/node_modules/.bin (and npm run, <project>/node_modules/.bin) first. */
export function isTransientBinDir(dir) {
  const d = dir.replace(/\\/g, "/").replace(/\/+$/, "");
  return /\/_npx\//.test(`${d}/`) || /\/node_modules\/\.bin$/.test(d);
}

/** Find an executable on PATH (honours PATHEXT on Windows). Returns its path or null. `installed: true` ignores transient package-runner folders. */
export function findBinary(name, env = process.env, { installed = false } = {}) {
  const dirs = (env.PATH ?? env.Path ?? "").split(path.delimiter).filter(Boolean).filter((d) => !installed || !isTransientBinDir(d));
  const exts = process.platform === "win32" ? ["", ...(env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)] : [""];
  for (const dir of dirs) {
    for (const ext of exts) {
      const file = path.join(dir, name + ext);
      try {
        if (fs.statSync(file).isFile()) return file;
      } catch {}
    }
  }
  return null;
}

function hasHook(list, marker) {
  return (
    Array.isArray(list) &&
    list.some((entry) => Array.isArray(entry?.hooks) && entry.hooks.some((h) => typeof h?.command === "string" && marker.test(h.command)))
  );
}

/** Merge the Archivum hooks into a parsed settings object. Returns the list of hook events added. */
export function mergeClaudeSettings(settings, { promptRecall = false } = {}) {
  const added = [];
  if (settings.hooks === undefined) settings.hooks = {};
  if (!settings.hooks || typeof settings.hooks !== "object" || Array.isArray(settings.hooks)) {
    throw new CliError('settings.json has a "hooks" value that is not an object; fix it by hand and run init again.');
  }
  for (const [event, command, marker] of promptRecall ? [...HOOKS, PROMPT_HOOK] : HOOKS) {
    if (settings.hooks[event] === undefined) settings.hooks[event] = [];
    if (!Array.isArray(settings.hooks[event])) throw new CliError(`settings.json hooks.${event} is not an array; fix it by hand and run init again.`);
    if (hasHook(settings.hooks[event], marker)) continue;
    settings.hooks[event].push({ hooks: [{ type: "command", command }] });
    added.push(event);
  }
  return added;
}

function runMcpAdd(bin, env) {
  const r = spawnSync(bin, mcpAddArgs(env), { encoding: "utf8", env, shell: process.platform === "win32", timeout: 60_000 });
  return { ok: r.status === 0 && !r.error, text: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim(), error: r.error };
}

function setupMcp(client, bin, { dryRun, env }) {
  const found = findBinary(bin, env);
  if (!found) {
    out(`  \`${bin}\` was not found on PATH. Register the MCP server yourself:`);
    out(`    ${MCP_COMMAND(bin, env)}`);
    if (client === "Codex") {
      out("  or add this to ~/.codex/config.toml:");
      for (const l of codexToml(env).split("\n")) out(`    ${l}`);
    }
    return;
  }
  if (dryRun) {
    out(`  would run: ${MCP_COMMAND(bin, env)}`);
    return;
  }
  const r = runMcpAdd(bin, env);
  if (r.ok) out(`  ran: ${MCP_COMMAND(bin, env)}`);
  else {
    out(`  \`${MCP_COMMAND(bin, env)}\` did not succeed${r.text ? ` (${r.text.split("\n")[0]})` : ""}. If archivum is already registered this is fine; otherwise run it yourself.`);
  }
}

function setupClaudeCode(home, { dryRun, env, promptRecall }) {
  out("Claude Code:");
  if (promptRecall && !findBinary("archivum", env, { installed: true })) {
    out("  --prompt-recall skipped: `archivum` is not on your PATH, and this hook runs before every prompt, so it cannot go through npx");
    out("  (that took 2.7-4.4 s per prompt when measured, against 0.2 s for the installed command). Run:");
    out("    npm install -g archivums");
    out("  then run `archivum init --claude-code --prompt-recall` again. The other hooks are installed below as usual.");
    promptRecall = false;
  }
  const dir = path.join(home, ".claude");
  const file = path.join(dir, "settings.json");
  let raw = null;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  let settings = {};
  if (raw !== null && raw.trim() !== "") {
    try {
      settings = JSON.parse(raw);
    } catch {
      throw new CliError(`${file} is not valid JSON; refusing to touch it. Fix it and run init again.`);
    }
    if (!settings || typeof settings !== "object" || Array.isArray(settings)) throw new CliError(`${file} is not a JSON object; refusing to touch it.`);
  }
  const added = mergeClaudeSettings(settings, { promptRecall });
  if (added.length === 0) out(`  hooks already present in ${file}`);
  else if (dryRun) out(`  would add ${added.join(" and ")} hook(s) to ${file}${raw !== null ? ` (backup: ${file}.archivum-bak)` : " (new file)"}`);
  else {
    fs.mkdirSync(dir, { recursive: true });
    const backup = `${file}.archivum-bak`;
    if (raw !== null && !fs.existsSync(backup)) {
      fs.writeFileSync(backup, raw);
      out(`  backed up ${file} -> ${backup}`);
    }
    atomicWrite(file, `${JSON.stringify(settings, null, 2)}\n`);
    out(`  added ${added.join(" and ")} hook(s) to ${file}`);
  }
  setupMcp("Claude Code", "claude", { dryRun, env });
}

function setupCodex({ dryRun, env, dir, home, agentsMd }) {
  out("Codex:");
  setupMcp("Codex", "codex", { dryRun, env });
  if (agentsMd) {
    const r = setupAgentsMd(dir, { dryRun, home });
    if (r.skipped) out(`  AGENTS.md not written: ${r.skipped}.`);
    else if (r.action === "unchanged") out(`  ${r.file} already has the Archivum block.`);
    else {
      const verb = { created: "create", added: "add the Archivum block to", updated: "update the Archivum block in" }[r.action];
      out(dryRun ? `  would ${verb} ${r.file}` : `  ${{ created: "created", added: "added the Archivum block to", updated: "updated the Archivum block in" }[r.action]} ${r.file}${r.backup ? ` (backup: ${r.backup})` : ""}`);
    }
    if (!dryRun && r.action !== "skipped") out("  Why: Codex has no session hooks, and in testing it only used Archivum once its project instructions told it to.");
  } else {
    out("  AGENTS.md left alone (--no-agents-md). Without instructions Codex may never call Archivum on its own.");
  }
  out("  Codex has no session hooks: store a session with the `save_transcript` tool or `archivum log` if you want it dreamed.");
}


const SERVER_ENTRY = { command: "npx", args: ["-y", "archivums", "mcp"] };

/** Claude Desktop launches the command itself, and on Windows `npx` is a .cmd file that cannot be spawned directly. */
function desktopEntry() {
  return process.platform === "win32" ? { command: "cmd", args: ["/c", "npx", "-y", "archivums", "mcp"] } : SERVER_ENTRY;
}

/** Where Claude Desktop keeps claude_desktop_config.json on this OS (derived from `home`, so tests never touch the real one). */
export function claudeDesktopDir(home, env = process.env) {
  if (process.platform === "win32") return path.join(env.APPDATA ?? path.join(home, "AppData", "Roaming"), "Claude");
  if (process.platform === "darwin") return path.join(home, "Library", "Application Support", "Claude");
  return path.join(env.XDG_CONFIG_HOME ?? path.join(home, ".config"), "Claude");
}

/** Add `mcpServers.archivum` to a JSON config file the client owns. Never removes anything; backs up once; idempotent. */
function setupJsonClient(label, file, entry, { dryRun }) {
  out(`${label}:`);
  let raw = null;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (e) {
    if (e.code !== "ENOENT") {
      out(`  could not read ${file} (${e.code ?? e.message}); skipped.`);
      return;
    }
  }
  let cfg = {};
  if (raw !== null && raw.trim() !== "") {
    try {
      cfg = JSON.parse(raw);
    } catch {
      out(`  ${file} is not valid JSON; left untouched. Fix it and run init again, or add this yourself under "mcpServers": "archivum": ${JSON.stringify(entry)}`);
      return;
    }
    if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) {
      out(`  ${file} is not a JSON object; left untouched.`);
      return;
    }
  }
  if (cfg.mcpServers !== undefined && (typeof cfg.mcpServers !== "object" || cfg.mcpServers === null || Array.isArray(cfg.mcpServers))) {
    out(`  "mcpServers" in ${file} is not an object; left untouched.`);
    return;
  }
  if (cfg.mcpServers?.archivum) {
    out(`  already registered in ${file}`);
    return;
  }
  if (dryRun) {
    out(`  would add the archivum server to ${file}${raw !== null ? ` (backup: ${file}.archivum-bak)` : " (new file)"}`);
    return;
  }
  cfg.mcpServers = { ...(cfg.mcpServers ?? {}), archivum: entry };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const backup = `${file}.archivum-bak`;
  if (raw !== null && !fs.existsSync(backup)) {
    fs.writeFileSync(backup, raw);
    out(`  backed up ${file} -> ${backup}`);
  }
  atomicWrite(file, `${JSON.stringify(cfg, null, 2)}\n`);
  out(`  added the archivum server to ${file}`);
}

function setupCursor(home, { dryRun }) {
  setupJsonClient("Cursor", path.join(home, ".cursor", "mcp.json"), SERVER_ENTRY, { dryRun });
  out("  Restart Cursor. This follows Cursor's documented mcp.json format; it has not been run in Cursor yet.");
}

function setupClaudeDesktop(home, { dryRun, env }) {
  setupJsonClient("Claude Desktop", path.join(claudeDesktopDir(home, env), "claude_desktop_config.json"), desktopEntry(), { dryRun });
  out("  Quit Claude Desktop completely (not just the window) and open it again. Claude may prefer its built-in memory unless you ask for Archivum.");
}

const hermesAdd = (env) => {
  const [command, ...args] = mcpLaunch(env);
  return ["mcp", "add", "archivum", "--command", command, "--args", ...args];
};

function setupHermes({ dryRun, env }) {
  out("Hermes:");
  const bin = "hermes";
  if (!findBinary(bin, env)) {
    out("  `hermes` was not found on PATH. Register the MCP server yourself:");
    out(`    ${bin} ${hermesAdd(env).join(" ")}`);
    return;
  }
  const opts = { encoding: "utf8", env, shell: process.platform === "win32", timeout: 60_000 };
  const list = spawnSync(bin, ["mcp", "list"], opts);
  if (!list.error && list.status === 0 && /^\s*archivum\s/m.test(`${list.stdout ?? ""}`)) {
    out("  already registered (hermes mcp list)");
    return;
  }
  if (dryRun) {
    out(`  would run: ${bin} ${hermesAdd(env).join(" ")}`);
    return;
  }
  // hermes asks "Enable all N tools? [Y/n/select]" and cancels when stdin is closed, so the answer is given on stdin
  const r = spawnSync(bin, hermesAdd(env), { ...opts, input: "Y\n" });
  const text = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  if (!r.error && r.status === 0 && !/Cancelled/i.test(text)) out(`  ran: ${bin} ${hermesAdd(env).join(" ")}. Start a new Hermes session to use the tools.`);
  else out(`  \`${bin} ${hermesAdd(env).join(" ")}\` did not succeed${text.trim() ? ` (${text.trim().split("\n").pop().trim()})` : ""}. Run it yourself.`);
}

export function initCommand(flags, env, home) {
  const all = flags.all;
  const pick = (name) => all || flags[name];
  const hermesHome = env.HERMES_HOME ?? path.join(home, ".hermes");
  let want = { claude: pick("claude-code"), codex: pick("codex"), hermes: pick("hermes"), cursor: pick("cursor"), desktop: pick("claude-desktop") };
  if (!Object.values(want).some(Boolean)) {
    want = {
      claude: fs.existsSync(path.join(home, ".claude")),
      codex: fs.existsSync(path.join(home, ".codex")) || findBinary("codex", env) !== null,
      hermes: fs.existsSync(hermesHome) || findBinary("hermes", env) !== null,
      cursor: fs.existsSync(path.join(home, ".cursor")),
      desktop: fs.existsSync(claudeDesktopDir(home, env)),
    };
    if (!Object.values(want).some(Boolean)) {
      out("No supported client detected (looked for Claude Code, Codex, Hermes, Cursor and Claude Desktop).");
      out("Run with --claude-code, --codex, --hermes, --cursor, --claude-desktop or --all to set one up anyway.");
      out("Any other MCP client: run `npx -y archivums mcp` as a stdio server.");
      return 0;
    }
  }
  const dryRun = Boolean(flags["dry-run"]);
  if (dryRun) out("Dry run: nothing will be changed.");
  const attempt = (label, fn) => {
    try {
      fn();
    } catch (e) {
      out(`${label}: ${e.message}`);
      failed = true;
    }
  };
  let failed = false;
  if (want.claude) setupClaudeCode(home, { dryRun, env, promptRecall: Boolean(flags["prompt-recall"]) });
  if (want.codex) setupCodex({ dryRun, env, dir: path.resolve(flags.dir ?? process.cwd()), home, agentsMd: !flags["no-agents-md"] });
  if (want.hermes) attempt("Hermes", () => setupHermes({ dryRun, env }));
  if (want.cursor) attempt("Cursor", () => setupCursor(home, { dryRun }));
  if (want.desktop) attempt("Claude Desktop", () => setupClaudeDesktop(home, { dryRun, env }));
  if (!dryRun) out("Done. Memory lives in ~/.archivum (or $ARCHIVUM_HOME). Next: `archivum status`.");
  return failed ? 1 : 0;
}
