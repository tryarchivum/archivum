import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// packages/cli/README.md is the page npmjs.com shows and the text agents read when a user pastes the package name.
// It said "7 tools" and "dreaming needs your LLM key" long after both stopped being true. These checks tie it to the code.
const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readme = fs.readFileSync(path.join(CLI, "README.md"), "utf8");
const mcp = fs.readFileSync(path.join(CLI, "src/mcp.js"), "utf8");
const cli = fs.readFileSync(path.join(CLI, "src/cli.js"), "utf8");
const toolNames = [...mcp.matchAll(/^    name: "([a-z_]+)",$/gm)].map((m) => m[1]);

test("npm README names every MCP tool and the right count", () => {
  assert.equal(toolNames.length, 17);
  for (const n of toolNames) assert.ok(readme.includes(`\`${n}\``), `README does not mention tool ${n}`);
  assert.match(readme, new RegExp(`${toolNames.length} tools`));
});

test("npm README says dreaming works without an API key (through the agent), and names the package vs the command", () => {
  assert.match(readme, /no API key/i);
  assert.match(readme, /dream_prepare/);
  assert.match(readme, /\*\*`archivums`\*\*/);
  assert.match(readme, /\*\*`archivum`\*\*/);
});

test("npm README lists every init flag and every hook the CLI accepts", () => {
  const usage = cli.slice(cli.indexOf("init ["), cli.indexOf("\n", cli.indexOf("init [")));
  for (const f of usage.match(/--[a-z-]+/g) ?? []) assert.ok(readme.includes(f), `README init row misses ${f}`);
  for (const h of ["session-start", "user-prompt", "stop"]) assert.ok(readme.includes(h), `README misses hook ${h}`);
});

test("npm README has no stale claims", () => {
  assert.doesNotMatch(readme, /\b7 tools\b|seven tools/i);
  assert.doesNotMatch(readme, /Dreaming needs your LLM/);
  assert.doesNotMatch(readme, /archivum-cli/);
});
