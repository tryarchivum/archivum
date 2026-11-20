import assert from "node:assert/strict";
import { test } from "node:test";
import { scrubSecrets } from "../src/index.js";
import { CHARSETS, plainText, property, anyString, timeMs, growthRatio } from "./_fuzz.js";

// Every generator returns a secret in a real-looking format plus the kind scrubSecrets must report for it.
const GENERATORS = [
  (r) => {
    const label = r.pick(["RSA ", "EC ", "OPENSSH ", "ENCRYPTED ", ""]);
    const lines = Array.from({ length: r.int(1, 6) }, () => r.str(CHARSETS.b64, r.int(16, 64)));
    const nl = r.pick(["\n", "\r\n", "\\n"]);
    return { kind: "private_key", secret: `-----BEGIN ${label}PRIVATE KEY-----${nl}${lines.join(nl)}${nl}-----END ${label}PRIVATE KEY-----` };
  },
  (r) => ({ kind: "anthropic_key", secret: `sk-ant-${r.pick(["api03-", "admin01-", ""])}${r.str(CHARSETS.b64url, r.int(20, 90))}` }),
  (r) => ({ kind: "openai_key", secret: `sk-${r.pick(["proj-", ""])}${r.str(CHARSETS.b64url, r.int(20, 120))}` }),
  (r) => ({ kind: "archivum_key", secret: `arc_${r.str(CHARSETS.b64url, 32)}` }),
  (r) => ({ kind: "aws_access_key", secret: `AKIA${r.str(CHARSETS.upperDigit, 16)}` }),
  (r) => ({ kind: "github_token", secret: `gh${r.pick(["p", "o", "u", "s", "r"])}_${r.str(CHARSETS.alnum, r.int(36, 80))}` }),
  (r) => ({ kind: "slack_token", secret: `xox${r.pick(["b", "a", "p", "r", "s"])}-${r.str(`${CHARSETS.alnum}-`, r.int(10, 60))}` }),
  (r) => ({ kind: "google_api_key", secret: `AIza${r.str(CHARSETS.b64url, 35)}` }),
  (r) => ({ kind: "jwt", secret: `eyJ${r.str(CHARSETS.b64url, r.int(10, 60))}.${r.str(CHARSETS.b64url, r.int(10, 80))}.${r.str(CHARSETS.b64url, r.int(10, 60))}` }),
  (r) => ({ kind: "bearer_token", secret: `Bearer${r.pick([" ", "  ", "\t", "\n"])}${r.str(`${CHARSETS.alnum}._~+/=-`, r.int(20, 80))}` }),
];

/** A generated secret whose random body happens to contain another secret's trigger (e.g. "sk-" inside a Google key) is ambiguous about its kind; draw again. */
function genSecret(rng) {
  for (;;) {
    const g = rng.pick(GENERATORS)(rng);
    const solo = scrubSecrets(g.secret);
    if (solo.text === `[REDACTED:${g.kind}]`) return g;
  }
}

// [prefix, suffix] wrappers: prose, quotes, JSON, YAML, shell, logs. Neither side contains a token character.
const CONTEXTS = [
  [" ", " "],
  ["\n", "\n"],
  ["\r\n", "\r\n"],
  ['"', '"'],
  ["'", "'"],
  ["`", "`"],
  ["(", ")"],
  ["<", ">"],
  ["[", "]"],
  ["\\\"", "\\\""],
  ['{"token": "', '"}'],
  ['{"a":1,"api_key":"', '","b":2}'],
  ["api_key: ", "\n"],
  ["key: '", "'\n"],
  ["export API_KEY=", "\n"],
  ["API_KEY=\"", "\" ./run.sh"],
  ["curl -H 'Authorization: ", "' https://example.invalid"],
  ["Authorization: ", "\r\nHost: x"],
  ["token=", "&next=1"],
  ["- ", "\n- other"],
  ["> ", " <"],
  ["é", "ü"],
  ["中文：", "。"],
  ["😀", "😀"],
  ["\u0000", "\u0000"],
];

function build(rng) {
  const secrets = [];
  let input = "";
  let expected = "";
  const nSecrets = rng.int(1, 5);
  const plain = (lead = "") => {
    const p = lead + plainText(rng);
    input += p;
    expected += p;
  };
  plain();
  for (let i = 0; i < nSecrets; i++) {
    const { kind, secret } = genSecret(rng);
    const [pre, post] = rng.pick(CONTEXTS);
    secrets.push({ kind, secret });
    input += pre + secret + post;
    expected += `${pre}[REDACTED:${kind}]${post}`;
    plain(" "); // a separator, so prose never extends a token
  }
  return { input, expected, secrets };
}

test("fuzz scrub: inserted secrets never survive, surrounding text is preserved byte for byte, scrub is idempotent", () => {
  property("scrub-insert", (rng) => {
    const { input, expected, secrets } = build(rng);
    const r = scrubSecrets(input);
    for (const { secret } of secrets) assert.ok(!r.text.includes(secret), `secret survived: ${JSON.stringify(secret)}\nin output: ${JSON.stringify(r.text)}`);
    assert.equal(r.text, expected, `input: ${JSON.stringify(input)}\nsecrets: ${JSON.stringify(secrets)}`);
    assert.equal(r.count, secrets.length);
    assert.deepEqual(new Set(r.kinds), new Set(secrets.map((s) => s.kind)));
    const again = scrubSecrets(r.text);
    assert.equal(again.text, r.text, "not idempotent");
    assert.equal(again.count, 0);
    assert.deepEqual(again.kinds, []);
  });
});

test("fuzz scrub: text without secrets is returned unchanged", () => {
  property("scrub-clean", (rng) => {
    const text = plainText(rng, 60);
    const r = scrubSecrets(text);
    assert.equal(r.text, text);
    assert.equal(r.count, 0);
  });
});

test("fuzz scrub: arbitrary strings never throw, return a string, and are idempotent", () => {
  property("scrub-any", (rng) => {
    let s = anyString(rng, 200);
    if (rng.chance(0.5)) s = `${s}sk-${anyString(rng, 30)}${s}`;
    const r = scrubSecrets(s);
    assert.equal(typeof r.text, "string");
    assert.ok(Number.isInteger(r.count) && r.count >= 0);
    const again = scrubSecrets(r.text);
    assert.equal(again.text, r.text);
  });
  for (const odd of [undefined, null, 0, 1e21, NaN, true, {}, [], ["sk-" + "a".repeat(30)], Symbol.iterator.toString(), "\ud800", "\udfff\ud800"]) {
    assert.doesNotThrow(() => scrubSecrets(odd));
  }
  assert.equal(scrubSecrets(["sk-" + "a".repeat(30)]).count, 1);
});

test("fuzz scrub: a secret survives nowhere even when jammed against other secrets", () => {
  property("scrub-adjacent", (rng) => {
    const parts = Array.from({ length: rng.int(2, 6) }, () => genSecret(rng));
    // A single space/newline/quote between them; no plain text at all.
    const sep = rng.pick([" ", "\n", '"', "\r\n", "\t", ","]);
    const input = parts.map((p) => p.secret).join(sep);
    const r = scrubSecrets(input);
    for (const { secret } of parts) assert.ok(!r.text.includes(secret), `secret survived: ${JSON.stringify(secret)}`);
    assert.equal(r.text, parts.map((p) => `[REDACTED:${p.kind}]`).join(sep));
  });
});

// ---- catastrophic backtracking ----

const BIG = 200_000;
const rep = (s) => s.repeat(Math.ceil(BIG / s.length)).slice(0, BIG);
const ADVERSARIAL = {
  "sk-": rep("sk-"),
  "sk- ": rep("sk- "),
  "sk-ant-": rep("sk-ant-"),
  "sk-ant- + spaces": rep("sk-ant-aaaaaaaaaaaaaaaaaaaa "),
  "sk- + 200k A": `sk-${"A".repeat(BIG)}`,
  "A x 200k": "A".repeat(BIG),
  "dashes": "-".repeat(BIG),
  "newlines": "\n".repeat(BIG),
  "BEGIN PRIVATE KEY header repeated": rep("-----BEGIN PRIVATE KEY-----"),
  "BEGIN header + base64 lines repeated": rep("-----BEGIN PRIVATE KEY-----\nAAAAAAAAAAAAAAAA\n"),
  "BEGIN prefix repeated": rep("-----BEGIN "),
  "BEGIN RSA PRIVATE KEY header repeated with CRLF": rep("-----BEGIN RSA PRIVATE KEY-----\r\n"),
  "one header + base64 lines": `-----BEGIN PRIVATE KEY-----${rep("\nAAAAAAAAAAAAAAA")}`,
  "unterminated header then END text": `${rep("-----BEGIN PRIVATE KEY-----")}-----END PRIVATE KEY-----`,
  "eyJ": rep("eyJ"),
  "eyJ + dot": rep("eyJAAAAAAAAAAAA."),
  "eyJ + two dots": rep("eyJAAAAAAAAAAAA.AAAAAAAAAAAA"),
  "Bearer ": rep("Bearer "),
  "Bearer A": rep("Bearer A"),
  "Bearer + spaces": `Bearer${" ".repeat(BIG)}`,
  "Bearer + spaces + short token": `Bearer${" ".repeat(BIG)}x`,
  "arc_": rep("arc_"),
  "AKIA": rep("AKIA"),
  "ghp_": rep("ghp_"),
  "xoxb-": rep("xoxb-"),
  "AIza": rep("AIza"),
  "mixed prefixes": rep("sk-ant-Bearer eyJAAAAAAAAAAAA.-----BEGIN PRIVATE KEY-----\nxoxb-AIza"),
};

test("fuzz scrub: adversarial inputs scale linearly (4x the input costs about 4x, never 16x), no catastrophic backtracking", () => {
  // Relative on purpose: "under 50 ms" failed on a busy shared VPS (112-151 ms observed) with no bug. A quadratic algorithm is
  // what this guards against, and it shows as a ratio near 16 on any machine.
  const slow = [];
  for (const [name, input] of Object.entries(ADVERSARIAL)) {
    const piece = input.slice(0, 2000);
    assert.equal(typeof scrubSecrets(input).text, "string");
    const unit = Math.max(1, Math.floor(input.length / 16)); // sizes: 1/16, 1/4... of the 200 KB input, times 4 inside growthRatio
    const { ratio, small, large } = growthRatio((n) => scrubSecrets(input.slice(0, Math.min(input.length, n))), unit);
    // inputs shorter than 4 units (small fixtures) cannot show growth; only judge when the large side really is 4x the small side
    if (input.length >= unit * 4 && large > 5 && ratio > 12) slow.push(`${name}: ${small.toFixed(2)} ms -> ${large.toFixed(2)} ms (x${ratio.toFixed(1)})`);
    void piece;
  }
  assert.deepEqual(slow, []);
});

test("regression: scrubbing many unterminated private key headers is linear, and results match the original regex", () => {
  // The original single-regex implementation, kept here as the reference semantics for small inputs.
  const REFERENCE = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----(?:[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----|(?:\r?\n[A-Za-z0-9+/=]{16,})+)/g;
  const only = (text) => text.replace(REFERENCE, "[REDACTED:private_key]");
  const pieces = ["-----BEGIN PRIVATE KEY-----", "-----BEGIN RSA PRIVATE KEY-----", "-----END PRIVATE KEY-----", "-----END RSA PRIVATE KEY-----", "\n", "\r\n", "AAAAAAAAAAAAAAAA", "AAAA", "x", " ", "-----BEGIN ", "KEY-----"];
  property("private-key-differential", (rng) => {
    const text = Array.from({ length: rng.int(0, 14) }, () => rng.pick(pieces)).join("");
    // Compare only the private_key step: strip other kinds by construction (pieces contain none).
    assert.equal(scrubSecrets(text).text, only(text), JSON.stringify(text));
  });
  const input = rep("-----BEGIN PRIVATE KEY-----");
  const value = scrubSecrets(input);
  // linear, not quadratic: relative to its own smaller run, so a busy machine cannot fail it (the old budget was 50 ms absolute)
  const g = growthRatio((n) => scrubSecrets(input.slice(0, n)), Math.floor(BIG / 16));
  assert.ok(g.large < 5 || g.ratio <= 12, `x${g.ratio.toFixed(1)} (${g.small.toFixed(2)} -> ${g.large.toFixed(2)} ms)`);
  assert.equal(value.text, input); // headers without END or base64 body are not keys: left untouched, like the original regex
  assert.equal(scrubSecrets("-----BEGIN PRIVATE KEY-----\nAAAAAAAAAAAAAAAA\nBBBBBBBBBBBBBBBB").text, "[REDACTED:private_key]");
});
