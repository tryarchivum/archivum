import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("../src", import.meta.url));

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
}

test("packages/core/src is browser-safe: no node: imports and no Node-only globals", () => {
  const files = walk(SRC).filter((f) => f.endsWith(".js"));
  assert.ok(files.length > 15);
  const offenders = [];
  for (const f of files) {
    const raw = fs.readFileSync(f, "utf8");
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    if (/["'`]node:[a-z_/]+["'`]/.test(code)) offenders.push(`${f}: node: specifier`);
    if (/\b(?:require|import)\s*\(\s*["'](?:fs|path|os|crypto|http|https|child_process|stream|util|url|buffer)["']/.test(code)) offenders.push(`${f}: bare builtin`);
    if (/from\s+["'](?:fs|path|os|crypto|http|https|child_process|stream|util|url|buffer)["']/.test(code)) offenders.push(`${f}: bare builtin import`);
    if (/\bBuffer\b|\bprocess\.(?:env|cwd|argv|platform)\b/.test(code)) offenders.push(`${f}: Node global`);
  }
  assert.deepEqual(offenders, []);
});

test("package.json declares an ESM, MIT, zero-dependency package with the right exports", () => {
  const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.name, "archivum-core");
  assert.equal(pkg.type, "module");
  assert.equal(pkg.license, "MIT");
  assert.equal(pkg.exports["."], "./src/index.js");
  assert.equal(pkg.dependencies, undefined);
});
