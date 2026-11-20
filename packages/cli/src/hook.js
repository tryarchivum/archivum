import fs from "node:fs";
import path from "node:path";
import { claudeCodeJsonlToEvents, scrubSecrets, sha256Hex } from "./core.js";
import { Store, archivumRoot, isSafeId, sanitizeSpace } from "./store.js";
import { contextFor, formatPromptRecall, promptRecall } from "./memory.js";
import { atomicWrite } from "./store.js";

export const MAX_CONTEXT_CHARS = 10_000;
const MAX_READ_BYTES = 32 * 1024 * 1024;

async function readStdin() {
  if (process.stdin.isTTY) return "";
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

function hookStore(input, flags, env) {
  const space = flags.space ?? (env.ARCHIVUM_SPACE || undefined);
  const cwd = typeof input.cwd === "string" && input.cwd ? input.cwd : process.cwd();
  return new Store(archivumRoot(env), sanitizeSpace(space ?? path.basename(path.resolve(cwd))));
}

/** Text to print for SessionStart ("" when there is nothing to inject). */
export function sessionStartOutput(store) {
  const { content } = contextFor(store, 4096);
  if (!content) return "";
  const additionalContext = `Archivum memory (space "${store.space}"):\n${content}`.slice(0, MAX_CONTEXT_CHARS);
  return JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext } });
}

const SEEN_FILE = "hook-seen.json";
const SEEN_SESSIONS = 20;
const SEEN_IDS = 200;

function readSeen(store) {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(store.dir, SEEN_FILE), "utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

/** Text to print for UserPromptSubmit ("" when nothing relevant, memory is empty, or the switch is off). */
export function userPromptOutput(store, input, env = process.env) {
  if (env.ARCHIVUM_PROMPT_RECALL === "0") return "";
  const session = String(input.session_id ?? "");
  const seen = readSeen(store);
  const shown = new Set(Array.isArray(seen[session]) ? seen[session] : []);
  const items = promptRecall(store, input.prompt, shown);
  const text = formatPromptRecall(store.space, items);
  if (!text) return "";
  if (session) {
    delete seen[session];
    seen[session] = [...shown, ...items.map((i) => i.id)].slice(-SEEN_IDS);
    const keep = Object.keys(seen).slice(-SEEN_SESSIONS);
    try {
      fs.mkdirSync(store.dir, { recursive: true });
      atomicWrite(path.join(store.dir, SEEN_FILE), `${JSON.stringify(Object.fromEntries(keep.map((k) => [k, seen[k]])))}\n`);
    } catch {}
  }
  return JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: text.slice(0, MAX_CONTEXT_CHARS) } });
}

export function recordStop(store, input) {
  const sessionId = String(input.session_id ?? "");
  const file = input.transcript_path;
  if (!sessionId || typeof file !== "string" || !file) return false;
  const stat = fs.statSync(file);
  if (stat.size > MAX_READ_BYTES) throw new Error(`transcript is larger than ${MAX_READ_BYTES} bytes`);
  const { events } = claudeCodeJsonlToEvents(fs.readFileSync(file, "utf8"));
  if (events.length === 0) return false;
  const clean = events.map((e) => ({ ...e, content: scrubSecrets(String(e.content ?? "")).text }));
  const id = isSafeId(sessionId) ? sessionId : `cc_${sha256Hex(sessionId).slice(0, 32)}`;
  store.upsertTranscript({ id, source: "claude-code", externalId: sessionId, events: clean });
  return true;
}

/** Never fails the session: exit 0 always, errors only on stderr with ARCHIVUM_DEBUG=1. */
export async function hookCommand(sub, flags, env) {
  try {
    let input = {};
    const raw = (await readStdin()).trim();
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object") input = parsed;
      } catch {}
    }
    const store = hookStore(input, flags, env);
    if (sub === "session-start") {
      const text = sessionStartOutput(store);
      if (text) process.stdout.write(`${text}\n`);
    } else if (sub === "user-prompt") {
      const text = userPromptOutput(store, input, env);
      if (text) process.stdout.write(`${text}\n`);
    } else if (sub === "stop") {
      recordStop(store, input);
    }
  } catch (e) {
    if (env.ARCHIVUM_DEBUG === "1") process.stderr.write(`archivum hook ${sub}: ${e?.stack ?? e}\n`);
  }
  return 0;
}
