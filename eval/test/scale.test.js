// The `scale` scenario: its generator (eval/fixtures/scale/generate.js) and the consistency of spec.json with expected.json.
// The CLI side (dream-cost gate, five-mode QA run) lives in run.test.js, which owns eval/results/.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { generate, makeRng, validateSpec } from "../fixtures/scale/generate.js";
import { loadFixtures, parseTranscript } from "../run.js";
import { scoreDocs } from "../score.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCALE_DIR = path.join(HERE, "..", "fixtures", "scale");
const spec = JSON.parse(readFileSync(path.join(SCALE_DIR, "spec.json"), "utf8"));
const expected = JSON.parse(readFileSync(path.join(SCALE_DIR, "expected.json"), "utf8"));
const clone = (o) => JSON.parse(JSON.stringify(o));
const generated = generate(spec);
const sessions = generated.map((t) => ({ ...t, ...parseTranscript(t.text), date: /Session date: (\d{4}-\d{2}-\d{2})\./.exec(t.text)[1], kind: /-([a-z]+)\.txt$/.exec(t.file)[1] }));
const factSessions = sessions.filter((s) => s.kind === "facts");
const distractors = sessions.filter((s) => s.kind !== "facts");
const re = (pattern, flags = "i") => new RegExp(pattern, flags);

// ---------------------------------------------------------------- generator

test("makeRng is a seeded, platform-independent mulberry32", () => {
  const a = makeRng(1);
  const b = makeRng(1);
  const seq = Array.from({ length: 5 }, () => a.next());
  assert.deepEqual(seq, Array.from({ length: 5 }, () => b.next()));
  assert.notDeepEqual(seq, Array.from({ length: 5 }, () => makeRng(2).next()));
  assert.ok(seq.every((x) => x >= 0 && x < 1));
  // fixed reference values: if these change, every generated transcript changes
  assert.deepEqual([makeRng(1).next(), makeRng(20260115).int(1000)], [0.6270739405881613, 408]);
  const shuffled = makeRng(7).shuffle([1, 2, 3, 4, 5, 6]);
  assert.deepEqual([...shuffled].sort(), [1, 2, 3, 4, 5, 6]);
});

test("generate is deterministic, pure and seed-dependent", () => {
  const before = JSON.stringify(spec);
  assert.deepEqual(generate(spec), generated);
  assert.equal(JSON.stringify(spec), before, "generate must not mutate the spec");
  const other = generate({ ...clone(spec), seed: spec.seed + 1 });
  assert.notDeepEqual(other.map((t) => t.text), generated.map((t) => t.text));
  assert.equal(other.length, generated.length);
  // loadFixtures runs the generator; nothing generated lives on disk
  assert.deepEqual(loadFixtures("scale").transcripts.map((t) => t.text), generated.map((t) => t.text));
  assert.equal(existsSync(path.join(SCALE_DIR, "transcripts")), false, "generated transcripts must not be committed");
});

test("48 well-formed labelled transcripts of 6 to 12 events in date order", () => {
  assert.equal(sessions.length, 48);
  const ids = new Set();
  for (const s of sessions) {
    assert.match(s.id, /^trn_evalscale\d{13}$/, s.file);
    assert.ok(!ids.has(s.id));
    ids.add(s.id);
    assert.equal(s.source, "claude-code");
    assert.equal(s.events, s.declaredEvents, s.file);
    assert.ok(s.events >= 6 && s.events <= 12, `${s.file}: ${s.events} events`);
    assert.equal(s.roles[0], "SYSTEM");
    assert.ok(s.roles.includes("USER") && s.roles.includes("ASSISTANT"), s.file);
    assert.ok(s.text.length < 6000 && !s.text.includes("\r"), s.file);
    assert.equal(s.text.split("\n").filter((l) => /^(USER|ASSISTANT|SYSTEM|TOOL\b[^:\n]*):/.test(l)).length, s.events, s.file);
    assert.ok(!/\{[A-Za-z0-9_]+\}/.test(s.text), `${s.file}: unresolved template slot`);
  }
  assert.deepEqual(sessions.map((s) => s.date), sessions.map((s) => s.date).sort());
  assert.deepEqual(generated.map((t) => t.file), [...generated.map((t) => t.file)].sort());
  assert.ok(new Set(sessions.map((s) => s.events)).size >= 5, "event counts should vary");
  assert.ok(sessions.every((s) => s.date >= spec.window.start && s.date <= spec.window.end));
});

test("17 fact sessions, 31 distractor sessions, five distractor kinds", () => {
  assert.equal(factSessions.length, 17);
  assert.equal(distractors.length, 31);
  assert.ok(distractors.length >= 30);
  const kinds = new Map();
  for (const s of distractors) kinds.set(s.kind, (kinds.get(s.kind) ?? 0) + 1);
  assert.deepEqual(Object.fromEntries([...kinds].sort()), Object.fromEntries(Object.entries(spec.distractorMix).sort()));
});

test("eight fact families, each changing 2 to 4 times, explicitly and silently", () => {
  assert.equal(spec.families.length, 8);
  assert.deepEqual(spec.families.map((f) => f.id).sort(), ["auth", "config", "log", "port", "release", "retry", "storage", "timeout"]);
  const how = { explicit: 0, silent: 0 };
  for (const f of spec.families) {
    const changes = f.values.length - 1;
    assert.ok(changes >= 2 && changes <= 4, `${f.id}: ${changes} changes`);
    assert.equal(f.values[0].how, "initial");
    for (const v of f.values.slice(1)) how[v.how]++;
  }
  assert.ok(how.explicit >= 8 && how.silent >= 8, JSON.stringify(how));
  assert.ok(new Set(spec.families.map((f) => f.values.length - 1)).size >= 3, "change counts should vary between families");
});

test("every value is stated in the fact session of its date; explicit changes say the old value is superseded, silent ones do not", () => {
  const SUPERSEDED = /supersed|no longer|retired|was .{1,80} until now/i;
  let explicit = 0;
  let silent = 0;
  for (const f of spec.families) {
    f.values.forEach((v, i) => {
      const session = factSessions.find((s) => s.date === v.date);
      assert.ok(session, `${f.id}[${i}]: no fact session on ${v.date}`);
      assert.ok(session.text.includes(v.v), `${f.id}[${i}]: ${v.v} not stated on ${v.date}`);
      if (i === 0) return;
      const old = f.values[i - 1].v;
      if (v.how === "explicit") {
        explicit++;
        const at = session.text.indexOf(old);
        assert.ok(at >= 0, `${f.id}[${i}]: explicit change does not name the old value ${old}`);
        assert.match(session.text.slice(Math.max(0, at - 200), at + old.length + 200), SUPERSEDED, `${f.id}[${i}]`);
      } else {
        silent++;
        assert.ok(!session.text.includes(old), `${f.id}[${i}]: silent change must not mention ${old}`);
      }
    });
  }
  assert.ok(explicit >= 8 && silent >= 8);
});

test("the three long-tail facts are stated once, early, and never repeated", () => {
  assert.equal(spec.longtail.length, 3);
  for (const lt of spec.longtail) {
    const token = /(cormorant-stg-2|#harbor-pager|max-depth 14)/.exec(lt.user)[1];
    const holders = sessions.filter((s) => s.text.includes(token));
    assert.equal(holders.length, 1, `${token} appears in ${holders.length} sessions`);
    assert.equal(holders[0].text.split(token).length - 1, 1, `${token} appears more than once`);
    assert.equal(holders[0].date, lt.date);
    assert.ok(lt.date <= "2025-06-30", "long-tail facts are stated early");
  }
  assert.ok(!sessions.some((s) => /14 releases/.test(s.text) && !s.text.includes("max-depth 14")), "the rollback limit appears only in its own session");
});

test("distractor sessions reuse the vocabulary, quote superseded values and reuse harbor's values for other projects", () => {
  const nouns = spec.families.map((f) => f.noun);
  for (const s of distractors) assert.ok(nouns.some((n) => s.text.includes(n)), `${s.file}: no shared vocabulary`);
  // a keyword retriever finds stale or foreign matches in distractors: they quote superseded values
  let quotingStale = 0;
  for (const s of distractors) {
    const date = s.date;
    const stale = spec.families.some((f) => f.values.some((v, i) => i < f.values.length - 1 && f.values[i + 1].date <= date && s.text.includes(v.v)));
    if (stale) quotingStale++;
  }
  assert.ok(quotingStale >= 15, `only ${quotingStale} distractor sessions quote a superseded value`);
  // the same values turn up for other projects (a current or past harbor value that is not harbor's)
  const reused = distractors.filter((s) => s.kind === "other" && spec.families.some((f) => f.values.some((v) => s.text.includes(v.v))));
  assert.ok(reused.length >= 3, `only ${reused.length} other-project sessions reuse a harbor value`);
  for (const s of distractors.filter((x) => x.kind === "incident")) assert.ok(new Set(s.text.match(/\d{4}-\d{2}-\d{2}/g)).size >= 2, `${s.file}: an incident session quotes a date besides the session date`);
  // hypotheticals and rejected options are labelled as such in their own words
  for (const s of distractors.filter((x) => x.kind === "considered")) assert.match(s.text, /considered|rejected|not adopted|did not/i, s.file);
  for (const s of distractors.filter((x) => x.kind === "hypo")) assert.match(s.text, /hypothetical|what-if|brainstorm|no change|nothing is decided/i, s.file);
});

test("every quoted old value was really in force on the date the distractor quotes", () => {
  const valueAt = (f, date) => {
    let cur = null;
    for (const v of f.values) if (v.date <= date) cur = v.v;
    return cur;
  };
  const byNoun = new Map(spec.families.map((f) => [f.noun, f]));
  let checked = 0;
  for (const s of distractors) {
    const quotes = [
      ...[...s.text.matchAll(/# Postmortem (\d{4}-\d{2}-\d{2})\nharbor ([a-z ]+): ([^\n]+)\n/g)].map((m) => [m[1], m[2], m[3]]),
      ...[...s.text.matchAll(/review: on (\d{4}-\d{2}-\d{2}) a deploy stalled\. At that time harbor's ([a-z ]+) was (.+?)\. The root cause/g)].map((m) => [m[1], m[2], m[3]]),
      // "notes/<date>.md:3: harbor <noun> <value>": the noun is one of the known nouns
      ...[...s.text.matchAll(/notes\/(\d{4}-\d{2}-\d{2})\.md:3: harbor ([^\n]+)/g)].map((m) => {
        const f = spec.families.find((x) => m[2].startsWith(`${x.noun} `));
        return [m[1], f?.noun, f ? m[2].slice(f.noun.length + 1) : m[2]];
      }),
    ];
    for (const [date, noun, value] of quotes) {
      const f = byNoun.get(noun);
      assert.ok(f, `${s.file}: unknown noun ${noun}`);
      assert.equal(valueAt(f, date), value, `${s.file}: harbor's ${noun} on ${date} was ${valueAt(f, date)}, quoted as ${value}`);
      assert.ok(date < s.date, `${s.file}: quotes the future`);
      assert.ok(valueAt(f, s.date) !== value, `${s.file}: quotes a value that is still current`);
      checked++;
    }
  }
  assert.ok(checked >= 15, `only ${checked} dated quotes were verified`);
});

test("validateSpec rejects a spec that cannot be generated", () => {
  assert.doesNotThrow(() => validateSpec(spec));
  const bad = (mutate, message) => {
    const s = clone(spec);
    mutate(s);
    assert.throws(() => validateSpec(s), message);
  };
  bad((s) => s.families[0].values.pop(), /3 to 5 values/);
  bad((s) => (s.families[0].values[1].date = "2025-05-01"), /dates must increase/);
  bad((s) => (s.distractorMix.other += 1), /distractorMix sums/);
  bad((s) => (s.window.end = "2026-01-01"), /window must contain/);
  bad((s) => (s.templates.other = []), /templates\.other missing/);
  bad((s) => (s.families[1].id = s.families[0].id), /duplicated/);
  const unresolved = clone(spec);
  unresolved.templates.other[0].events[0].t = "Question about {nope}";
  assert.throws(() => generate(unresolved), /unknown slot \{nope\}/);
});

// ---------------------------------------------------------------- spec.json and expected.json agree

test("expected.json is consistent with the generated world: latest values true, older ones rejected, 24 checks, 16 questions", () => {
  assert.equal(expected.checks.length, 24);
  assert.equal(expected.questions.length, 16);
  assert.deepEqual(expected.extra_modes, ["notes-top-10"]);
  assert.equal(expected.dream_cost_gate, true);
  const family = (id) => spec.families.find((f) => id.split("-")[1] === f.id);
  let withReject = 0;
  for (const q of expected.questions) {
    const f = family(q.id);
    if (!f) continue; // long-tail questions
    const [latest, ...older] = [...f.values].reverse().map((v) => v.v);
    assert.ok(re(q.answer, q.flags).test(latest), `${q.id}: answer does not match the latest value ${latest}`);
    assert.ok(!re(q.reject, q.flags).test(latest), `${q.id}: reject matches the latest value`);
    for (const old of older) {
      assert.ok(!re(q.answer, q.flags).test(old), `${q.id}: answer matches superseded ${old}`);
      assert.ok(re(q.reject, q.flags).test(old), `${q.id}: reject misses superseded ${old}`);
    }
    withReject++;
  }
  assert.equal(withReject, 13, "13 questions about changing facts, 3 long-tail");
  assert.equal(expected.questions.filter((q) => q.reject == null).length, 3);
  // current-value checks match exactly the latest value; old-value checks match every superseded value and not the latest
  for (const f of spec.families) {
    const current = expected.checks.find((c) => c.id === `${f.id}-current`);
    const oldMarked = expected.checks.find((c) => c.id === `${f.id}-old-marked`);
    const latest = f.values.at(-1).v;
    assert.ok(re(current.pattern, current.flags).test(latest), `${current.id} misses ${latest}`);
    assert.ok(!re(current.pattern, current.flags).test(f.values.at(-2).v), `${current.id} also matches the previous value`);
    assert.ok(!re(oldMarked.pattern, oldMarked.flags).test(latest), `${oldMarked.id} matches the latest value`);
    for (const old of f.values.slice(0, -1)) assert.ok(re(oldMarked.pattern, oldMarked.flags).test(old.v), `${oldMarked.id} misses ${old.v}`);
  }
  // rejected-but-never-adopted options are caught by one check and are not a true value
  const considered = expected.checks.find((c) => c.id === "considered-not-adopted");
  for (const f of spec.families) {
    for (const alt of f.considered) assert.ok(re(considered.pattern).test(alt), `considered-not-adopted misses ${alt}`);
    for (const v of f.values) assert.ok(!re(considered.pattern).test(v.v), `considered-not-adopted matches the real value ${v.v}`);
  }
  // every answer is in the generated transcripts
  const all = sessions.map((s) => s.text).join("\n");
  for (const q of expected.questions) assert.match(all, re(q.answer, q.flags), q.id);
});

test("the seed wiki states only the first values and none of the later ones", () => {
  const { seedDocs } = loadFixtures("scale");
  const seed = Object.values(seedDocs).join("\n").replace(/`/g, "");
  for (const f of spec.families) {
    assert.ok(seed.includes(f.values[0].v), `${f.id}: first value missing from the seed`);
    for (const v of f.values.slice(1)) assert.ok(!seed.includes(v.v), `${f.id}: seed already contains ${v.v}`);
  }
  for (const token of ["cormorant-stg-2", "#harbor-pager", "max-depth"]) assert.ok(!seed.includes(token));
  const r = scoreDocs(seedDocs, expected);
  assert.ok(r.score < 0.3, `seed score ${r.score}`);
  assert.ok(r.failed.length >= 19);
});
