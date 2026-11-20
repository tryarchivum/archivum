import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// What a visitor sees first on GitHub and npm. These tests keep the pages tied to the code, so they cannot go stale quietly.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const pkg = JSON.parse(read("packages/cli/package.json"));
const mcp = read("packages/cli/src/mcp.js");
const tools = [...mcp.matchAll(/^    name: "([a-z_]+)",$/gm)].length;

test("package.json has the metadata npmjs.com shows in its sidebar", () => {
  assert.equal(pkg.name, "archivums");
  assert.ok(pkg.description.length > 60 && pkg.description.length < 260, "a real description, not a slogan and not an essay");
  assert.equal(pkg.license, "MIT");
  assert.equal(pkg.homepage, "https://tryarchivum.com");
  assert.match(pkg.repository.url, /github\.com\/tryarchivum\/archivum/);
  assert.match(pkg.bugs.url, /github\.com\/tryarchivum\/archivum\/issues/);
  assert.ok(pkg.keywords.length >= 8 && new Set(pkg.keywords).size === pkg.keywords.length, "enough distinct keywords to be found");
  for (const k of ["mcp", "mcp-server", "agent-memory", "claude-code", "codex"]) assert.ok(pkg.keywords.includes(k), `keyword ${k}`);
  assert.deepEqual(Object.keys(pkg.bin), ["archivum"]);
});

test("the README opens the right way: logo, name, one-line pitch, badges as real images, the one install command", () => {
  for (const f of ["README.md"]) {
    const s = read(f);
    assert.match(s, /<picture>[\s\S]*logo-dark\.svg[\s\S]*logo-light\.svg[\s\S]*<\/picture>/, `${f}: logo that works in dark and light mode`);
    assert.match(s, /^# Archivum$/m, `${f}: title`);
    assert.equal((s.match(/<a href="[^"]+"><img src="https:\/\/img\.shields\.io\/[^"]+" alt="[^"]+"><\/a>/g) ?? []).length, 6, `${f}: six badges written as HTML (Markdown inside an HTML block is not rendered)`);
    assert.doesNotMatch(s, /<p align="center">\s*\[!\[/, `${f}: no Markdown badges inside an HTML block`);
    assert.ok(s.includes("npx archivums init"), `${f}: install command`);
    assert.doesNotMatch(s, /archivum-cli/, `${f}: old package name`);
  }
});

test("the MCP badge and the tool counts in every README match the server", () => {
  for (const f of ["README.md", "packages/cli/README.md"]) {
    const s = read(f);
    for (const m of s.matchAll(/\b(\d+)(?: MCP)? tools\b|MCP-(\d+)%20tools/g)) assert.equal(Number(m[1] ?? m[2]), tools, `${f}: "${m[0]}"`);
  }
});

test("every local image and link a README points to exists in the repo", () => {
  for (const f of ["README.md"]) {
    const s = read(f);
    const refs = [...s.matchAll(/(?:src|srcset)="((?!https?:)[^"]+)"/g)].map((m) => m[1]);
    refs.push(...[...s.matchAll(/\]\(((?!https?:|#|mailto:)[^)\s]+)\)/g)].map((m) => m[1]));
    for (const r of refs) assert.ok(fs.existsSync(path.join(ROOT, r.split("#")[0])), `${f}: ${r} does not exist`);
  }
});

test("the npm README uses absolute image URLs (npm cannot resolve relative paths) and no Mermaid (npm does not render it)", () => {
  const s = read("packages/cli/README.md");
  for (const m of s.matchAll(/<img [^>]*src="([^"]+)"/g)) assert.match(m[1], /^https:\/\//, `image ${m[1]}`);
  assert.doesNotMatch(s, /```mermaid/);
});

test("plugin manifests carry the same version and homepage as the package", () => {
  for (const f of [".claude-plugin/plugin.json", ".codex-plugin/plugin.json", ".cursor-plugin/plugin.json"]) {
    const m = JSON.parse(read(f));
    assert.equal(m.version, pkg.version, `${f} version`);
    assert.equal(m.homepage, "https://tryarchivum.com", `${f} homepage`);
  }
});

test("the README shows the contract address exactly, in its own code block, and it matches the website", () => {
  const CA = "0xda4283f14b487034b90d865aac489994f2c680c4";
  const s = read("README.md");
  assert.ok(s.includes("```\n" + CA + "\n```"), "CA in a code block of its own (GitHub shows a copy button on it)");
  assert.equal((s.match(/0x[0-9a-fA-F]{40}/g) ?? []).length, 1, "exactly one address in the README");
  if (fs.existsSync(path.join(ROOT, "index.html"))) assert.ok(read("index.html").includes(CA), "the landing page shows the same address");
});

test("public pages are English only: no Indonesian README, no Indonesian text in the files visitors read", () => {
  assert.equal(fs.existsSync(path.join(ROOT, "README.id.md")), false);
  assert.doesNotMatch(read("README.md"), /README\.id|Bahasa/);
  const words = /\b(yang|untuk|tidak|dengan|adalah|kamu|karena|sudah|belum|saya|jangan|agent-mu|bisa)\b/i;
  for (const f of ["README.md", "CONTRIBUTING.md", "SECURITY.md", "CHANGELOG.md", "packages/cli/README.md", "skills/archivum/SKILL.md"]) {
    if (!fs.existsSync(path.join(ROOT, f))) continue;
    const bad = read(f).split("\n").filter((l) => words.test(l)).slice(0, 3);
    assert.deepEqual(bad, [], `${f} contains Indonesian text`);
  }
});
