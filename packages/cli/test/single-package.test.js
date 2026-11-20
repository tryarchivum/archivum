import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: "utf8", shell: process.platform === "win32", ...opts });

test("the package is published as archivums (the owner's npm name) and still installs the command `archivum`", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(CLI, "package.json"), "utf8"));
  assert.equal(pkg.name, "archivums");
  assert.deepEqual(Object.keys(pkg.bin), ["archivum"], "one bin, so `npx archivums <cmd>` runs it");
});

test("package.json: no archivum-core dependency, vendor/ is shipped, prepack and postpack are wired", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(CLI, "package.json"), "utf8"));
  assert.equal(pkg.dependencies, undefined, "the published package must not depend on archivum-core");
  assert.ok(pkg.files.includes("vendor") && pkg.files.includes("src") && pkg.files.includes("bin"));
  assert.match(pkg.scripts.prepack, /vendor-core\.mjs/);
  assert.match(pkg.scripts.postpack, /vendor-core\.mjs --clean/);
});

test("the vendored copy is git-ignored and not present in a clean checkout (so it can never shadow the source)", () => {
  const ignore = fs.readFileSync(path.resolve(CLI, "../../.gitignore"), "utf8");
  assert.match(ignore, /packages\/cli\/vendor/);
  assert.equal(fs.existsSync(path.join(CLI, "vendor")), false, "vendor/ must be removed again after pack");
});

test("npm pack produces ONE self-contained package: core inside, no dependency, cleaned up after", { timeout: 120_000 }, () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "archivum-pack-"));
  try {
    const r = sh(npm, ["pack", "--json", "--pack-destination", out], { cwd: CLI });
    assert.equal(r.status, 0, r.stderr);
    const info = JSON.parse(r.stdout)[0];
    const names = info.files.map((f) => f.path.replace(/\\/g, "/"));
    assert.ok(names.includes("vendor/core/index.js"), "core entry point is in the tarball");
    assert.ok(names.includes("vendor/core/scrub.js"), "scrub.js is in the tarball");
    assert.ok(names.includes("bin/archivum.js") && names.includes("src/cli.js"));
    assert.ok(!names.some((n) => n.startsWith("test/")), "tests are not shipped");
    assert.equal(fs.existsSync(path.join(CLI, "vendor")), false, "postpack removed the generated copy");
    assert.ok(info.size < 120_000, `tarball stays small: ${info.size} bytes`);

    // extract and read the manifest that npm will publish
    const tgz = path.join(out, info.filename);
    const x = sh("tar", ["-xzf", tgz, "-C", out]);
    assert.equal(x.status, 0, x.stderr);
    const published = JSON.parse(fs.readFileSync(path.join(out, "package", "package.json"), "utf8"));
    assert.equal(published.dependencies, undefined);
    assert.equal(JSON.stringify(published).includes("archivum-core"), false, "no reference to archivum-core in the published manifest");
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test("the packed package runs on its own, with no packages/core next to it and no archivum-core in node_modules", { timeout: 180_000 }, () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "archivum-solo-"));
  try {
    const packed = sh(npm, ["pack", "--json", "--pack-destination", work], { cwd: CLI });
    assert.equal(packed.status, 0, packed.stderr);
    const tgz = path.join(work, JSON.parse(packed.stdout)[0].filename);
    const app = path.join(work, "app");
    fs.mkdirSync(app);
    fs.writeFileSync(path.join(app, "package.json"), '{"name":"t","version":"1.0.0"}');
    const inst = sh(npm, ["i", tgz, "--no-audit", "--no-fund", "--ignore-scripts"], { cwd: app });
    assert.equal(inst.status, 0, inst.stderr);
    assert.equal(fs.existsSync(path.join(app, "node_modules", "archivum-core")), false, "npm did not install a second package");
    const bin = path.join(app, "node_modules", "archivums", "bin", "archivum.js");
    const home = path.join(work, "home");
    const env = { ...process.env, ARCHIVUM_HOME: home, HOME: work, USERPROFILE: work };
    const run = (...args) => spawnSync(process.execPath, [bin, "--space", "solo", ...args], { encoding: "utf8", env });
    let r = run("--version");
    assert.equal(r.status, 0, r.stderr);
    r = run("remember", "tests run with pnpm vitest");
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Saved note/);
    r = run("recall", "pnpm vitest");
    assert.match(r.stdout, /pnpm vitest/);
    // the part that proves core is really the vendored one: secret scrubbing (core) and the prompt hook (core search) both work
    const fake = "npm_" + "aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY3zA5";
    run("remember", `publish with ${fake}`);
    const notes = fs.readFileSync(path.join(home, "spaces", "solo", "notes.jsonl"), "utf8");
    assert.ok(!notes.includes(fake), "npm token is scrubbed by the vendored core");
    assert.match(notes, /REDACTED:npm_token/);
    const h = spawnSync(process.execPath, [bin, "hook", "user-prompt"], { encoding: "utf8", env: { ...env, ARCHIVUM_SPACE: "solo" }, input: JSON.stringify({ session_id: "s", cwd: work, prompt: "which pnpm command runs the tests" }) });
    assert.equal(h.status, 0);
    assert.match(h.stdout, /pnpm vitest/);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
});

test("src/core.js falls back to the sibling checkout when vendor/ is absent (this repo), and only then", async () => {
  const mod = await import("../src/core.js");
  for (const name of ["scrubSecrets", "buildCorpus", "searchCorpus", "tokenize", "runDream", "claudeCodeJsonlToEvents", "ompJsonlToEvents", "newId", "sha256Hex"]) {
    assert.equal(typeof mod[name], "function", name);
  }
});
