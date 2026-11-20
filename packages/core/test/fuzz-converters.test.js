import assert from "node:assert/strict";
import { test } from "node:test";
import { claudeCodeJsonlToEvents, ompJsonlToEvents } from "../src/index.js";
import { anyString, plainText, property, timeMs } from "./_fuzz.js";

const ROLES = new Set(["user", "assistant", "tool"]);
const CONVERTERS = { claude: claudeCodeJsonlToEvents, omp: ompJsonlToEvents };

// ---- random JSON-ish values ----

const KEYS = ["type", "role", "content", "message", "text", "id", "name", "input", "arguments", "tool_use_id", "toolCallId", "toolName", "isError", "isSidechain", "isMeta", "timestamp", "title", "cwd", "__proto__", "constructor", "prototype", "toString", "hasOwnProperty", "\u0000", "", "a"];
const BIG_NUMBERS = [0, -0, 1, -1, 1.5, 1e21, 1e308, -1e308, 5e-324, Number.MAX_SAFE_INTEGER, 2 ** 53 + 2, 4294967296];

function value(rng, depth = 0) {
  const r = rng.next();
  if (depth > 4 || r < 0.35) {
    const k = rng.int(0, 5);
    if (k === 0) return null;
    if (k === 1) return rng.chance(0.5);
    if (k === 2) return rng.pick(BIG_NUMBERS);
    return anyString(rng, 30);
  }
  if (r < 0.65) return Array.from({ length: rng.int(0, 5) }, () => value(rng, depth + 1));
  const o = {};
  for (let i = rng.int(0, 5); i > 0; i--) Object.defineProperty(o, rng.pick(KEYS), { value: value(rng, depth + 1), enumerable: true, configurable: true, writable: true });
  return o;
}

/** A value that is `good` with probability 1-p and otherwise a random (usually wrong-typed) value. */
const maybeWrong = (rng, good, p = 0.2) => (rng.chance(p) ? value(rng, 3) : good());

const text = (rng) => (rng.chance(0.15) ? anyString(rng, 80) : `${plainText(rng, 6)}x`);

function claudeBlock(rng) {
  const type = rng.pick(["text", "text", "tool_use", "tool_result", "thinking", "image", "unknown", 42, null]);
  const b = { type };
  b.text = maybeWrong(rng, () => text(rng));
  b.id = maybeWrong(rng, () => `toolu_${rng.int(0, 5)}`);
  b.tool_use_id = maybeWrong(rng, () => `toolu_${rng.int(0, 5)}`);
  b.name = maybeWrong(rng, () => rng.pick(["Bash", "Read", "x".repeat(200), ""]));
  b.input = value(rng, 2);
  b.content = rng.chance(0.5) ? maybeWrong(rng, () => text(rng)) : maybeWrong(rng, () => [{ type: "text", text: text(rng) }, "bare", value(rng, 4)]);
  return rng.chance(0.1) ? text(rng) : rng.chance(0.05) ? value(rng, 3) : b;
}

function claudeEntry(rng) {
  const message = {
    role: maybeWrong(rng, () => rng.pick(["user", "assistant", "user", "assistant", "system", "tool"]), 0.1),
    content: rng.chance(0.3) ? maybeWrong(rng, () => text(rng)) : maybeWrong(rng, () => Array.from({ length: rng.int(0, 6) }, () => claudeBlock(rng)), 0.15),
  };
  const e = {
    type: rng.pick(["user", "assistant", "summary", 1]),
    message: maybeWrong(rng, () => message, 0.1),
    isSidechain: maybeWrong(rng, () => rng.chance(0.1), 0.05),
    isMeta: maybeWrong(rng, () => rng.chance(0.1), 0.05),
    timestamp: maybeWrong(rng, () => rng.pick(["2026-01-02T03:04:05.678Z", "2026-01-02", "not a date", "", "+275760-09-13T00:00:00.000Z", "+275760-09-13T00:00:00.001Z", "0000-01-01T00:00:00Z"]), 0.2),
  };
  return rng.chance(0.05) ? value(rng, 1) : e;
}

function ompBlock(rng) {
  const type = rng.pick(["text", "text", "toolCall", "thinking", "image", "weird", 7, null]);
  const b = { type };
  b.text = maybeWrong(rng, () => text(rng));
  b.id = maybeWrong(rng, () => `call_${rng.int(0, 5)}`);
  b.name = maybeWrong(rng, () => rng.pick(["bash", "read", "y".repeat(200), ""]));
  b.arguments = value(rng, 2);
  return rng.chance(0.1) ? text(rng) : rng.chance(0.05) ? value(rng, 3) : b;
}

function ompEntry(rng) {
  const type = rng.pick(["session", "title", "message", "message", "message", "message", "model_change", "custom", 5, null]);
  const role = maybeWrong(rng, () => rng.pick(["user", "assistant", "toolResult", "assistant", "user", "bashExecution"]), 0.1);
  const message = {
    role,
    content: rng.chance(0.3) ? maybeWrong(rng, () => text(rng)) : maybeWrong(rng, () => Array.from({ length: rng.int(0, 6) }, () => ompBlock(rng)), 0.15),
    toolName: maybeWrong(rng, () => rng.pick(["bash", "", "z".repeat(100)]), 0.3),
    toolCallId: maybeWrong(rng, () => `call_${rng.int(0, 5)}`, 0.3),
    isError: maybeWrong(rng, () => rng.chance(0.3), 0.2),
  };
  const e = {
    type,
    id: maybeWrong(rng, () => "sess-1"),
    cwd: maybeWrong(rng, () => "/work"),
    title: maybeWrong(rng, () => "A title "),
    timestamp: maybeWrong(rng, () => rng.pick(["2026-01-02T03:04:05.678Z", "bad", ""]), 0.2),
    message: maybeWrong(rng, () => message, 0.1),
  };
  return rng.chance(0.05) ? value(rng, 1) : e;
}

const ENTRY = { claude: claudeEntry, omp: ompEntry };

/** A line of text: usually valid JSON (random entry), sometimes truncated, garbage or raw nonsense. */
function line(rng, kind) {
  const r = rng.next();
  if (r < 0.55) return JSON.stringify(ENTRY[kind](rng));
  if (r < 0.7) {
    const full = JSON.stringify(ENTRY[kind](rng));
    return full.slice(0, rng.int(0, full.length));
  }
  if (r < 0.8) return anyString(rng, 120).replace(/\n/g, " ");
  if (r < 0.85) return JSON.stringify(value(rng, 0)) ?? "undefined";
  if (r < 0.9) return rng.pick(["null", "true", "123", '"str"', "[]", "{}", "[[[[[[[[", "{\"a\":", "1e999", "-1e999", "{\"message\":{\"role\":\"user\",\"content\":1e999}}", "\u0000", "\ufeff{}", "{}\r"]);
  if (r < 0.95) return `${'{"message":{"role":"user","content":"'}${anyString(rng, 50).replace(/[\\"\n]/g, "")}`; // truncated mid-string
  return " ".repeat(rng.int(0, 5));
}

function document(rng, kind) {
  const eol = rng.pick(["\n", "\r\n", "\n", "\r\n\r\n", "\n\n"]);
  const lines = Array.from({ length: rng.int(0, 25) }, () => line(rng, kind));
  if (rng.chance(0.1)) lines.push(`${"x".repeat(rng.int(1000, 60_000))}`);
  const body = lines.map((l) => (rng.chance(0.1) ? l : l + eol)).join("");
  return rng.chance(0.1) ? body.replace(/\r?\n/g, rng.pick(["\r", "\n", "\r\n"])) : body;
}

function assertInvariants(kind, out, opts, inputLineCount) {
  assert.equal(typeof out, "object");
  assert.ok(out !== null);
  assert.ok(Array.isArray(out.events));
  assert.ok(Number.isInteger(out.skipped) && out.skipped >= 0 && out.skipped <= inputLineCount, `skipped=${out.skipped} lines=${inputLineCount}`);
  assert.ok(out.events.length <= opts.maxEvents, `events ${out.events.length} > maxEvents ${opts.maxEvents}`);
  for (const ev of out.events) {
    assert.ok(ROLES.has(ev.role), `role ${ev.role}`);
    assert.equal(typeof ev.content, "string");
    const limit = ev.role === "tool" ? Math.min(opts.maxToolChars, opts.maxContentChars) + 80 : opts.maxContentChars;
    assert.ok(ev.content.length <= limit, `content ${ev.content.length} > ${limit} (${ev.role})`);
    if (ev.name !== undefined) {
      assert.equal(typeof ev.name, "string");
      assert.ok(ev.name.length > 0 && ev.name.length <= 64);
    }
    if (ev.ts !== undefined) assert.match(ev.ts, /^[+-]?\d{4,6}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    assert.deepEqual(Object.keys(ev).filter((k) => !["role", "content", "name", "ts"].includes(k)), [], "unexpected event keys");
  }
  assert.equal(Object.getPrototypeOf(out.events), Array.prototype);
  if (kind === "omp") {
    assert.deepEqual(Object.keys(out.meta).sort(), ["cwd", "id", "startedAt", "title"]);
    for (const v of Object.values(out.meta)) assert.ok(v === null || typeof v === "string");
  }
}

const countLines = (text) => text.split("\n").filter((l) => l.trim()).length;

for (const kind of Object.keys(CONVERTERS)) {
  const convert = CONVERTERS[kind];

  test(`fuzz ${kind}: random and corrupt JSONL never throws and respects the event/size bounds`, () => {
    property(`${kind}-random`, (rng) => {
      const doc = document(rng, kind);
      const opts = { maxEvents: rng.int(1, 12), maxContentChars: rng.int(1, 200), maxToolChars: rng.int(1, 120) };
      const out = convert(doc, opts);
      assertInvariants(kind, out, opts, countLines(doc));
      assert.deepEqual(convert(doc, opts), out, "not deterministic");
      assertInvariants(kind, convert(doc), { maxEvents: 5000, maxContentChars: 50_000, maxToolChars: 4_000 }, countLines(doc));
    });
  });

  test(`fuzz ${kind}: valid conversation lines survive garbage between them, in order`, () => {
    property(`${kind}-valid-interleaved`, (rng) => {
      const expected = [];
      const lines = [];
      let garbage = 0;
      for (let i = rng.int(1, 30); i > 0; i--) {
        if (rng.chance(0.4)) {
          // "}" first: never valid JSON, always a non-blank line that yields nothing
          lines.push(`}${anyString(rng, 60).replace(/[\r\n]/g, " ")}`);
          garbage++;
          continue;
        }
        const role = rng.pick(["user", "assistant"]);
        const content = `m${i} ${plainText(rng, 8)}`.replace(/\s+$/, "");
        const entry = kind === "claude" ? { type: role, message: { role, content }, timestamp: "2026-05-06T07:08:09.123Z" } : { type: "message", timestamp: "2026-05-06T07:08:09.123Z", message: { role, content } };
        lines.push(JSON.stringify(entry));
        expected.push({ role, content, ts: "2026-05-06T07:08:09.123Z" });
      }
      const doc = lines.join(rng.pick(["\n", "\r\n"]));
      const out = convert(doc, { maxEvents: 5000, maxContentChars: 50_000 });
      assert.deepEqual(out.events, expected);
      assert.equal(out.skipped, garbage);
      const cap = rng.int(1, 6);
      assert.deepEqual(convert(doc, { maxEvents: cap }).events, expected.slice(-cap), "most recent events win");
    });
  });

  test(`fuzz ${kind}: maxEvents 0 yields no events`, () => {
    const entry = kind === "claude" ? { type: "user", message: { role: "user", content: "hello" } } : { type: "message", message: { role: "user", content: "hello" } };
    const doc = `${JSON.stringify(entry)}\n${JSON.stringify(entry)}\n`;
    assert.equal(convert(doc, { maxEvents: 0 }).events.length, 0);
    assert.equal(convert(doc, { maxEvents: 1 }).events.length, 1);
  });

  test(`fuzz ${kind}: non-string input, empty input, prototype keys, extreme shapes`, () => {
    for (const input of [undefined, null, 0, 123, {}, [], "", "\n\n\n", "\r\n", "\ud800", "\udfff\ud800\n\ud800", "{".repeat(100), "[".repeat(1_000_000), `${"[".repeat(100_000)}${"]".repeat(100_000)}`]) {
      const out = convert(input);
      assert.ok(Array.isArray(out.events));
      assert.ok(Number.isInteger(out.skipped));
    }
    const polluted = [
      '{"__proto__":{"polluted":"yes"},"message":{"__proto__":{"polluted":"yes"},"role":"user","content":"hi","constructor":{"prototype":{"polluted":"yes"}}}}',
      '{"constructor":{"prototype":{"polluted":"yes"}},"type":"message","message":{"role":"assistant","content":[{"type":"tool_use","id":"__proto__","name":"constructor","input":{"__proto__":{"polluted":"yes"}}},{"type":"tool_result","tool_use_id":"__proto__","content":"x"}]}}',
    ].join("\n");
    convert(polluted);
    assert.equal({}.polluted, undefined);
    assert.equal(Object.prototype.polluted, undefined);
    // tool_result referencing "__proto__" / "constructor" must not resolve to Object.prototype members
    const out = convert(`${polluted}\n`);
    for (const ev of out.events) assert.ok(ev.name === undefined || typeof ev.name === "string");
  });

  test(`fuzz ${kind}: huge lines and deep nesting stay fast and bounded`, () => {
    const big = "a".repeat(2_000_000);
    const hugeContent = kind === "claude" ? `{"message":{"role":"user","content":"${big}"}}` : `{"type":"message","message":{"role":"user","content":"${big}"}}`;
    const deepValue = `${"[".repeat(5000)}1${"]".repeat(5000)}`;
    const deepInput =
      kind === "claude"
        ? `{"message":{"role":"assistant","content":[{"type":"tool_use","id":"a","name":"t","input":${deepValue}}]}}`
        : `{"type":"message","message":{"role":"assistant","content":[{"type":"toolCall","id":"a","name":"t","arguments":${deepValue}}]}}`;
    const garbageLine = "x".repeat(3_000_000);
    const longName = kind === "claude" ? `{"message":{"role":"assistant","content":[{"type":"tool_use","name":"${"n".repeat(100_000)}","input":{}}]}}` : `{"type":"message","message":{"role":"assistant","content":[{"type":"toolCall","name":"${"n".repeat(100_000)}","arguments":{}}]}}`;
    const { ms, value: out } = timeMs(() => convert([hugeContent, deepInput, garbageLine, longName, "\r\n".repeat(100_000)].join("\n"), { maxContentChars: 1000 }));
    assert.ok(ms < 1500, `${ms} ms`);
    assert.ok(out.events.every((e) => e.content.length <= 1100));
    assert.ok(out.events.every((e) => !e.name || e.name.length <= 64));
    assert.ok(out.skipped >= 1);
  });

  test(`fuzz ${kind}: invalid UTF-16 and unusual line endings do not break parsing`, () => {
    property(`${kind}-utf16`, (rng) => {
      const bad = anyString(rng, 40);
      const content = JSON.stringify(`hello ${bad}`); // JSON.stringify escapes lone surrogates, so this is valid JSON
      const raw = `"hello ${bad.replace(/[\\"\u0000-\u001f]/g, "")}"`; // raw lone surrogates inside a JSON string
      const mk = (c) => (kind === "claude" ? `{"message":{"role":"user","content":${c}}}` : `{"type":"message","message":{"role":"user","content":${c}}}`);
      const doc = [mk(content), mk(raw), mk(raw).replace(/\}$/, "")].join(rng.pick(["\n", "\r\n", "\r\n\r\n"]));
      const out = convert(doc);
      assert.ok(out.events.length >= 2, "both complete lines survive");
      assert.equal(out.events[0].content, `hello ${bad}`);
      assert.equal(out.skipped, 1);
      assertInvariants(kind, out, { maxEvents: 5000, maxContentChars: 50_000, maxToolChars: 4_000 }, 3);
    });
  });
}
