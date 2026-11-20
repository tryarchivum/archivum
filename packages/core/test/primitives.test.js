import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { MemoryWiki, newId, parseFrontmatter, scrubSecrets, sha256Hex } from "../src/index.js";

test("sha256Hex matches node:crypto for many lengths, unicode and long inputs", () => {
  const samples = ["", "abc", "a".repeat(55), "a".repeat(56), "a".repeat(63), "a".repeat(64), "a".repeat(65), "héllo wörld ✓ 😀", "x".repeat(100_000), "line\r\nbreak\n"];
  for (const s of samples) assert.equal(sha256Hex(s), createHash("sha256").update(s, "utf8").digest("hex"), `len ${s.length}`);
  assert.equal(sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

test("newId: prefix, base64url, unique", () => {
  const a = newId("note");
  assert.match(a, /^note_[A-Za-z0-9_-]{22}$/);
  assert.match(newId("trn"), /^trn_[A-Za-z0-9_-]{22}$/);
  assert.notEqual(a, newId("note"));
});

test("scrubSecrets redacts known secret shapes and leaves ordinary text alone", () => {
  const secrets = {
    "sk-ant-api03-abcdefghijklmnopqrstuvwxyz": "anthropic_key",
    "sk-proj_abcdefghijklmnopqrstuvwxyz": "openai_key",
    [`arc_${"a".repeat(32)}`]: "archivum_key",
    AKIAIOSFODNN7EXAMPLE: "aws_access_key",
    [`ghp_${"b".repeat(36)}`]: "github_token",
    [`npm_${"aB3dE5fG7h".repeat(3)}aB3dE5`]: "npm_token",
    "xoxb-1234567890-abcdef": "slack_token",
    [`AIza${"c".repeat(35)}`]: "google_api_key",
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghij": "jwt",
    "-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----": "private_key",
    "-----BEGIN PRIVATE KEY-----\nMIIabc\n-----END PRIVATE KEY-----": "private_key",
    "Bearer abcdefghijklmnopqrstuvwxyz": "bearer_token",
  };
  for (const [secret, kind] of Object.entries(secrets)) {
    const r = scrubSecrets(`before ${secret} after`);
    assert.equal(r.text, `before [REDACTED:${kind}] after`, kind);
    assert.deepEqual(r.kinds, [kind]);
    assert.equal(r.count, 1);
  }
  const plain = "Run `npm test` in /srv/app; the bearer of bad news; sk-learn is a library; task-123; arc_short; ghp_ is a prefix; npm_config_cache and npm_package_name are env names; Bearer token; model claude-haiku-5-5";
  const r = scrubSecrets(plain);
  assert.equal(r.text, plain);
  assert.equal(r.count, 0);
  assert.deepEqual(r.kinds, []);
  assert.equal(scrubSecrets(scrubSecrets("k sk-ant-api03-abcdefghijklmnopqrstuvwxyz").text).count, 0);
  const multi = scrubSecrets(`a ${"AKIAIOSFODNN7EXAMPLE"} b ${"AKIAIOSFODNN7EXAMPL2"}`);
  assert.equal(multi.count, 2);
  assert.deepEqual(multi.kinds, ["aws_access_key"]);
});

test("parseFrontmatter", () => {
  const fm = parseFrontmatter('---\nname: auth\ndescription: "how login works"\nmetadata: from trn_a, area: access\n---\nBody text\n');
  assert.deepEqual([fm.name, fm.description, fm.metadata, fm.hasFrontmatter, fm.body], ["auth", "how login works", "from trn_a, area: access", true, "Body text\n"]);
  assert.equal(fm.fields.name, "auth");
  const crlf = parseFrontmatter("---\r\nname: x\r\ndescription: y\r\n---\r\nbody");
  assert.deepEqual([crlf.name, crlf.description, crlf.body], ["x", "y", "body"]);
  const none = parseFrontmatter("# Title\n---\nnot: frontmatter\n---\n");
  assert.deepEqual([none.name, none.description, none.metadata, none.hasFrontmatter, none.body], [null, null, null, false, "# Title\n---\nnot: frontmatter\n---\n"]);
  const unclosed = parseFrontmatter("---\nname: x\nno end");
  assert.equal(unclosed.hasFrontmatter, false);
  assert.equal(parseFrontmatter("---\nname:\n---\n").name, null);
});

test("MemoryWiki: DocsApi semantics", () => {
  const w = new MemoryWiki({}, { maxDocs: 3 });
  const a = w.write("/b.md", "---\nname: b\ndescription: about b\n---\nx");
  assert.match(a.sha256, /^[0-9a-f]{64}$/);
  assert.equal(a.sha256, sha256Hex("---\nname: b\ndescription: about b\n---\nx"));
  w.write("/a/c.md", "c");
  assert.deepEqual(w.list().map((d) => d.path), ["/a/c.md", "/b.md"]);
  assert.deepEqual(w.list({ prefix: "/a/" }).map((d) => d.path), ["/a/c.md"]);
  assert.deepEqual(w.list()[1], { path: "/b.md", bytes: 38, sha256: a.sha256, name: "b", description: "about b" });
  assert.equal(w.list()[0].name, null);
  assert.deepEqual(w.get("/a/c.md"), { path: "/a/c.md", content: "c", sha256: sha256Hex("c") });
  assert.equal(w.get("/nope.md"), null);
  // bytes are UTF-8 bytes
  w.write("/u.md", "é😀");
  assert.equal(w.list().find((d) => d.path === "/u.md").bytes, 6);
  w.delete("/u.md");
  // sha precondition
  assert.throws(() => w.write("/b.md", "y", { expectSha256: "0".repeat(64) }), { code: "conflict" });
  assert.throws(() => w.write("/new.md", "y", { expectSha256: "0".repeat(64) }), { code: "conflict" });
  assert.doesNotThrow(() => w.write("/b.md", "y", { expectSha256: a.sha256 }));
  // invalid paths
  for (const bad of ["x", "/x/../y", "/a b.md", "/", "//a", "/a/", `/${"a".repeat(200)}`, 5, null]) assert.throws(() => w.write(bad, "y"), { code: "invalid_path" }, String(bad));
  assert.throws(() => w.get("nope"), { code: "invalid_path" });
  assert.throws(() => w.list({ prefix: "nope" }), { code: "invalid_path" });
  // size & quota
  assert.throws(() => w.write("/z.md", "x".repeat(100_001)), { code: "too_large" });
  assert.throws(() => new MemoryWiki({}, { maxBytes: 3 }).write("/z.md", "abcd"), { code: "too_large" });
  w.write("/z.md", "z");
  assert.throws(() => w.write("/q.md", "q"), { code: "quota" });
  w.write("/z.md", "z2"); // overwrite is not a new doc
  // rename / delete
  assert.throws(() => w.rename("/z.md", "/b.md"), { code: "conflict" });
  assert.throws(() => w.rename("/nope.md", "/n.md"), { code: "not_found" });
  w.rename("/z.md", "/y.md");
  assert.equal(w.get("/y.md").content, "z2");
  assert.equal(w.get("/z.md"), null);
  assert.throws(() => w.delete("/z.md"), { code: "not_found" });
  w.delete("/y.md");
  assert.deepEqual(Object.keys(w.snapshot()), ["/a/c.md", "/b.md"]);
});

test("MemoryWiki: clone is independent; initial content is validated; snapshot is sorted", () => {
  const w = new MemoryWiki({ "/b.md": "b", "/a.md": "a" });
  assert.deepEqual(Object.keys(w.snapshot()), ["/a.md", "/b.md"]);
  const c = w.clone();
  c.write("/c.md", "c");
  c.write("/a.md", "A");
  assert.deepEqual(w.snapshot(), { "/a.md": "a", "/b.md": "b" });
  assert.deepEqual(c.snapshot(), { "/a.md": "A", "/b.md": "b", "/c.md": "c" });
  assert.equal(c.maxDocs, w.maxDocs);
  assert.throws(() => new MemoryWiki({ "bad": "x" }), { code: "invalid_path" });
});

test("scrubSecrets: npm access tokens are redacted, npm environment variable names are not", () => {
  const token = `npm_${"aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY3zA5"}`;
  assert.equal(token.length, 40);
  assert.equal(scrubSecrets(`publish with ${token} now`).text, "publish with [REDACTED:npm_token] now");
  const env = "npm_config_cache=/tmp npm_package_name=foo npm_lifecycle_event=test npm_execpath=/usr/bin/npm";
  assert.equal(scrubSecrets(env).text, env);
  // tokens are exactly 36 characters after the prefix: a longer run is some other identifier and is left alone
  const longer = `npm_${"a".repeat(37)}`;
  assert.equal(scrubSecrets(longer).text, longer);
  // linear on adversarial input
  const t = performance.now();
  scrubSecrets("npm_".repeat(50_000));
  assert.ok(performance.now() - t < 500);
});
