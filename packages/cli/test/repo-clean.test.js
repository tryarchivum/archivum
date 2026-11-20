import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// A test that runs the real `init` from the repository root once wrote a managed block into the repo's own AGENTS.md.
// The CLI refuses nothing there (it is a normal project folder), so the only protection is that tests never run from it.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

test("the repo's own AGENTS.md and CLAUDE.md carry no Archivum-managed block, and no .archivum-bak file lies around", () => {
  for (const f of ["AGENTS.md", "CLAUDE.md"]) {
    const p = path.join(ROOT, f);
    if (fs.existsSync(p)) assert.doesNotMatch(fs.readFileSync(p, "utf8"), /archivum:begin/, `${f} was modified by a test or by hand`);
  }
  const stray = fs.readdirSync(ROOT).filter((n) => n.endsWith(".archivum-bak"));
  assert.deepEqual(stray, [], "a test left a backup file in the repo root");
});

test("every test that spawns `init` runs it from a sandbox folder (never the repo root)", () => {
  const dir = path.join(ROOT, "packages/cli/test");
  const offenders = [];
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith(".test.js"))) {
    const src = fs.readFileSync(path.join(dir, f), "utf8");
    for (const m of src.matchAll(/await run\(\[\s*"init"[^\]]*\],\s*\{([^}]*)\}\)/g)) {
      if (!/cwd:/.test(m[1])) offenders.push(`${f}: ${m[0].slice(0, 80)}`);
    }
  }
  assert.deepEqual(offenders, [], "these run init with the repo root as the working directory");
});
