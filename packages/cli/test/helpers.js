import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export const BIN = fileURLToPath(new URL("../bin/archivum.js", import.meta.url));
export const FAKE_SECRET = "sk-ant-api03-FAKEFAKEFAKEFAKEFAKEFAKE1234";

/** A sandbox: temp HOME, ARCHIVUM_HOME and a bin dir that is the whole PATH (plus system dirs). */
export function sandbox({ withClaude = false, withCodex = false, withArchivum = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "archivums-"));
  const home = path.join(root, "home");
  const archivumHome = path.join(root, "archivum-home");
  const bin = path.join(root, "bin");
  const work = path.join(root, "proj-x");
  const callLog = path.join(root, "calls.log");
  for (const d of [home, archivumHome, bin, work]) fs.mkdirSync(d, { recursive: true });
  const shim = (name) => {
    if (process.platform === "win32") fs.writeFileSync(path.join(bin, `${name}.cmd`), `@echo off\r\necho ${name} %* >> "${callLog}"\r\n`);
    else {
      fs.writeFileSync(path.join(bin, name), `#!/bin/sh\necho "${name} $@" >> "${callLog}"\n`);
      fs.chmodSync(path.join(bin, name), 0o755);
    }
  };
  if (withClaude) shim("claude");
  if (withCodex) shim("codex");
  if (withArchivum) shim("archivum");
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^(path|home|userprofile|appdata|xdg_config_home|archivum_.*|anthropic_api_key|openai_api_key|hermes_.*|claude.*|codex.*|cursor.*)$/i.test(k)) env[k] = v;
  const sys = process.platform === "win32" ? [path.join(process.env.SystemRoot ?? "C:\\Windows", "System32")] : ["/usr/bin", "/bin"];
  env.PATH = [bin, ...sys].join(path.delimiter);
  env.HOME = home;
  env.USERPROFILE = home;
  env.ARCHIVUM_HOME = archivumHome;
  const calls = () => (fs.existsSync(callLog) ? fs.readFileSync(callLog, "utf8").split(/\r?\n/).map((l) => l.trim()).filter(Boolean) : []);
  const cleanup = () => fs.rmSync(root, { recursive: true, force: true });
  return { root, home, archivumHome, bin, work, env, calls, cleanup };
}

/** Spawn the real binary. Resolves {code, stdout, stderr}. */
export function run(args, { env, cwd, input } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], { env, cwd, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input ?? "");
  });
}

export const spaceDir = (sb, space) => path.join(sb.archivumHome, "spaces", space);
export const readJson = (f) => JSON.parse(fs.readFileSync(f, "utf8"));

function textOf(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((b) => (typeof b === "string" ? b : (b.text ?? (b.content !== undefined ? textOf(b.content) : "")))).join("\n");
  return "";
}

/** Scripted conversation shared by both fake providers. */
function script({ organizer, step, firstUser, toolText }) {
  if (organizer) {
    if (step === 0) return { calls: [{ name: "list_docs", input: {} }, { name: "read_doc", input: { path: "/_index.md" } }] };
    if (step === 1) {
      const paths = [...new Set([...toolText.matchAll(/\/[A-Za-z0-9._-]+\.md/g)].map((m) => m[0]))].filter((p) => p !== "/_index.md").sort();
      const index = `# Index\n\n## facts\n${paths.map((p) => `[[${p.slice(1, -3)}]] - page`).join("\n")}\n`;
      return { calls: [{ name: "write_doc", input: { path: "/_index.md", content: index } }] };
    }
    return { calls: [{ name: "submit", input: { summary: "fake organizer done", changes: ["rebuilt index"] } }] };
  }
  const id = /Input id: (\S+)/.exec(firstUser)?.[1] ?? "unknown";
  const slug = id.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  if (step === 0) return { text: `Reading the docs for ${id}`, calls: [{ name: "list_docs", input: {} }, { name: "read_doc", input: { path: "/_index.md" } }] };
  if (step === 1) {
    const content = `---\nname: fact-${slug}\ndescription: facts learned from ${id}\n---\nRun tests with npm test. Leaked key ${FAKE_SECRET} must not survive.\n`;
    return { calls: [{ name: "write_doc", input: { path: `/fact-${slug}.md`, content } }] };
  }
  return { calls: [{ name: "submit", input: { summary: `fake analyzer done for ${id}`, touched: [`/fact-${slug}.md`] } }] };
}

/**
 * Local fake LLM server. kind: "anthropic" | "openai".
 * options.failOrganizer: answer organizer requests with a non-retryable 400.
 */
export function startFakeLlm(kind, { failOrganizer = false, failAll = 0 } = {}) {
  const requests = [];
  let n = 0;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const json = JSON.parse(body || "{}");
      requests.push({ url: req.url, headers: req.headers, body: json });
      const tools = json.tools ?? [];
      const submit = tools.find((t) => (t.name ?? t.function?.name) === "submit");
      const schema = submit?.input_schema ?? submit?.function?.parameters;
      const organizer = Boolean(schema?.properties?.changes);
      const msgs = json.messages ?? [];
      const firstUser = textOf(msgs.find((m) => m.role === "user")?.content);
      const step = msgs.filter((m) => m.role === "assistant").length;
      const toolText = JSON.stringify(msgs.slice(1));
      const send = (code, obj) => {
        res.writeHead(code, { "content-type": "application/json" });
        res.end(JSON.stringify(obj));
      };
      if (failAll) return send(failAll, kind === "anthropic" ? { type: "error", error: { type: "authentication_error", message: "bad key" } } : { error: { message: "bad key", type: "invalid_request_error" } });
      if (organizer && failOrganizer) {
        return send(400, kind === "anthropic" ? { type: "error", error: { type: "invalid_request_error", message: "organizer rejected" } } : { error: { message: "organizer rejected", type: "invalid_request_error" } });
      }
      const s = script({ organizer, step, firstUser, toolText });
      const calls = s.calls.map((c) => ({ ...c, id: `call_${++n}` }));
      if (kind === "anthropic") {
        const content = [...(s.text ? [{ type: "text", text: s.text }] : []), ...calls.map((c) => ({ type: "tool_use", id: c.id, name: c.name, input: c.input }))];
        send(200, { id: `msg_${n}`, type: "message", role: "assistant", model: json.model, content, stop_reason: "tool_use", usage: { input_tokens: 100, output_tokens: 20 } });
      } else {
        send(200, {
          id: `chatcmpl_${n}`,
          object: "chat.completion",
          model: json.model,
          choices: [
            {
              index: 0,
              finish_reason: "tool_calls",
              message: {
                role: "assistant",
                content: s.text ?? null,
                tool_calls: calls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.input) } })),
              },
            },
          ],
          usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
        });
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      resolve({
        requests,
        baseUrl: kind === "anthropic" ? `http://127.0.0.1:${port}` : `http://127.0.0.1:${port}/v1`,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

/** env additions that point `dream` at a fake server. */
export function llmEnv(kind, fake) {
  return kind === "anthropic"
    ? { ARCHIVUM_LLM_PROVIDER: "anthropic", ARCHIVUM_LLM_API_KEY: "test-key-anthropic", ARCHIVUM_LLM_BASE_URL: fake.baseUrl, ARCHIVUM_ANALYZER_MODEL: "fake-analyzer", ARCHIVUM_ORGANIZER_MODEL: "fake-organizer" }
    : { ARCHIVUM_LLM_PROVIDER: "openai", ARCHIVUM_LLM_API_KEY: "test-key-openai", ARCHIVUM_LLM_BASE_URL: fake.baseUrl, ARCHIVUM_ANALYZER_MODEL: "fake-analyzer", ARCHIVUM_ORGANIZER_MODEL: "fake-organizer" };
}
