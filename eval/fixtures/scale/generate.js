// Deterministic transcript generator for the `scale` scenario. Pure: no I/O, no network, no clock, no Math.random.
//
//   generate(spec) -> [{ file, text }]   (spec = parsed eval/fixtures/scale/spec.json)
//
// The same spec always yields byte-identical transcripts (mulberry32 PRNG seeded from spec.seed, drawn in a fixed order).
// run.js calls it every time the scenario is loaded; the transcripts are never written to disk or committed.
//
// What it builds (see spec.json for the data):
//   * fact sessions: one per distinct change date. Each value of each fact family is stated in the session of its date, either
//     as a user statement or as tool output plus an assistant restatement; "explicit" changes also say that the previous value
//     is superseded, "silent" changes just state the new value. Three long-tail facts are stated once, early, never repeated.
//   * distractor sessions: reuse the same vocabulary ("port", "config file", "retry policy", ...) in contexts that are NOT the
//     current value of the harbor fact: other projects, hypotheticals, "considered but did not do it", past incidents and notes
//     that quote a value that really was valid on the quoted date, and tool-output dumps.
// Every sentence is true in the fictional world, so a model that reads the history correctly can still answer exactly.

const ROLES = { U: "USER", A: "ASSISTANT", T: "TOOL bash" };
const DAY_MS = 86_400_000;
const HISTORY_KINDS = new Set(["hypo", "incident", "dump"]);

/** mulberry32: 32-bit state, integer arithmetic only, so the sequence is identical on every platform. */
export function makeRng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (n) => Math.floor(next() * n),
    range: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    shuffle: (arr) => {
      const out = [...arr];
      for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
      }
      return out;
    },
  };
}

const dayNumber = (iso) => Date.parse(`${iso}T00:00:00Z`) / DAY_MS;
const isoFromDay = (n) => new Date(n * DAY_MS).toISOString().slice(0, 10);
const pad = (n, w) => String(n).padStart(w, "0");

function fill(template, slots, where) {
  return template.replace(/\{([A-Za-z0-9_]+)\}/g, (_, key) => {
    if (!(key in slots)) throw new Error(`${where}: template uses unknown slot {${key}}: ${template}`);
    return String(slots[key]);
  });
}

function fillEvents(events, slots, where) {
  return events.map((e) => ({ role: ROLES[e.r], text: fill(e.t, slots, where) }));
}

/** Index of the value in force on `date` (-1 before the first value). */
function currentIndex(family, date) {
  let cur = -1;
  family.values.forEach((v, i) => {
    if (v.date <= date) cur = i;
  });
  return cur;
}

/** Throws with every problem found; a spec that passes can always be generated. */
export function validateSpec(spec) {
  const errors = [];
  const need = (cond, msg) => {
    if (!cond) errors.push(msg);
  };
  need(spec && typeof spec === "object", "spec must be an object");
  if (errors.length) throw new Error(`invalid scale spec: ${errors.join("; ")}`);
  need(Number.isInteger(spec.seed), "seed must be an integer");
  need(/^trn_[A-Za-z0-9_-]+$/.test(spec.idPrefix ?? "") && spec.idPrefix.length <= 20, "idPrefix must start with trn_ and leave room for digits");
  need(Number.isInteger(spec.sessions) && spec.sessions > 0, "sessions must be a positive integer");
  need(Number.isInteger(spec.minEvents) && Number.isInteger(spec.maxEvents) && spec.minEvents >= 2 && spec.minEvents <= spec.maxEvents, "minEvents/maxEvents invalid");
  need(Array.isArray(spec.otherProjects) && spec.otherProjects.length >= 3, "need at least 3 otherProjects");
  for (const k of ["ack", "explicit", "causes", "filler", "openers"]) need(Array.isArray(spec[k]) && spec[k].length > 0, `${k} must be a non-empty array`);
  need(typeof spec.restate === "string", "restate must be a string");
  need(spec.filler?.some((f) => f.events.length === 1), "filler needs at least one single-event segment");
  const families = Array.isArray(spec.families) ? spec.families : [];
  need(families.length >= 1, "families must not be empty");
  const seen = new Set();
  for (const f of families) {
    const w = `family ${f.id}`;
    need(typeof f.id === "string" && !seen.has(f.id), `${w}: id missing or duplicated`);
    seen.add(f.id);
    need(Array.isArray(f.values) && f.values.length >= 3 && f.values.length <= 5, `${w}: needs 3 to 5 values (2 to 4 changes)`);
    for (const [i, v] of (f.values ?? []).entries()) {
      need(/^\d{4}-\d{2}-\d{2}$/.test(v.date ?? ""), `${w}: value ${i} needs an ISO date`);
      need(i === 0 ? v.how === "initial" : v.how === "explicit" || v.how === "silent", `${w}: value ${i} has a bad "how"`);
      need(i === 0 || v.date > f.values[i - 1].date, `${w}: value dates must increase`);
    }
    need(new Set((f.values ?? []).map((v) => v.v)).size === (f.values ?? []).length, `${w}: duplicate values`);
    need(f.statements?.length >= 3 && f.tool?.length >= 1 && f.others?.length >= 3 && f.considered?.length >= 1, `${w}: needs statements (3), tool, others (3), considered`);
    need(typeof f.noun === "string" && typeof f.key === "string", `${w}: noun and key required`);
  }
  const mix = spec.distractorMix ?? {};
  const mixTotal = Object.values(mix).reduce((a, b) => a + b, 0);
  const factDates = new Set([...families.flatMap((f) => f.values.map((v) => v.date)), ...(spec.longtail ?? []).map((l) => l.date)]);
  need(spec.sessions - factDates.size === mixTotal, `distractorMix sums to ${mixTotal} but ${spec.sessions} sessions minus ${factDates.size} fact sessions is ${spec.sessions - factDates.size}`);
  need(mixTotal >= (spec.minDistractors ?? 0), `only ${mixTotal} distractor sessions (minDistractors ${spec.minDistractors})`);
  for (const kind of Object.keys(mix)) need(Array.isArray(spec.templates?.[kind]) && spec.templates[kind].length > 0, `templates.${kind} missing`);
  need(spec.window && spec.window.start < spec.window.end && spec.window.start <= [...factDates].sort()[0] && [...factDates].sort().at(-1) <= spec.window.end, "window must contain every fact date");
  if (errors.length) throw new Error(`invalid scale spec: ${errors.join("; ")}`);
}

// ---------------------------------------------------------------- segments (small groups of events)

function statementSegment(spec, rng, family, index) {
  const v = family.values[index];
  const old = index > 0 ? family.values[index - 1].v : "";
  const slots = { v: v.v, date: v.date, noun: family.noun, old };
  const where = `${family.id}[${index}]`;
  const explicit = v.how === "explicit" ? fill(rng.pick(spec.explicit), slots, where) : "";
  if (rng.next() < 0.6) {
    // a user states it; an explicit change adds the supersession either to the user's message or to the assistant's reply
    const user = fill(rng.pick(family.statements), slots, where);
    const inUser = explicit && rng.next() < 0.5;
    const reply = explicit && !inUser ? `Recorded. ${explicit}` : rng.pick(spec.ack);
    return [
      { role: ROLES.U, text: inUser ? `${user} ${explicit}` : user },
      { role: ROLES.A, text: reply },
    ];
  }
  // tool output shows it; the assistant restates it with the date
  const tool = rng.pick(family.tool);
  const restate = fill(spec.restate, slots, where);
  return [
    { role: ROLES.T, text: `$ ${fill(tool.cmd, slots, where)}\n${fill(tool.out, slots, where)}` },
    { role: ROLES.A, text: explicit ? `${restate} ${explicit}` : restate },
  ];
}

function longtailSegment(lt) {
  return [
    { role: ROLES.U, text: lt.user },
    { role: ROLES.A, text: lt.assistant },
  ];
}

/** Slots for a distractor template about `family` on `date`; the {old}/{incdate} pair only when a superseded value exists. */
function distractorSlots(spec, rng, family, date, project) {
  const cur = currentIndex(family, date);
  const slots = {
    noun: family.noun,
    key: family.key,
    date,
    proj: project,
    alt: rng.pick(family.considered),
    cause: rng.pick(spec.causes),
  };
  slots.x = fill(rng.pick(family.others), { proj: project }, `${family.id}.others`);
  const g = rng.shuffle(family.others).slice(0, 2);
  slots.g1 = fill(g[0], { proj: "gantry" }, `${family.id}.others`);
  slots.g2 = fill(g[1], { proj: "gantry" }, `${family.id}.others`);
  if (cur >= 1) {
    // a value that really was in force and has been superseded by `date`; the quoted date lies inside its window
    const j = rng.int(cur);
    const from = dayNumber(family.values[j].date);
    const to = dayNumber(family.values[j + 1].date) - 1;
    slots.old = family.values[j].v;
    slots.incdate = isoFromDay(rng.range(from, to));
    slots.hasOld = true;
  }
  return slots;
}

function distractorSegment(spec, rng, kind, family, date, project) {
  const slots = distractorSlots(spec, rng, family, date, project);
  const applicable = spec.templates[kind].filter((t) => !t.needsOld || slots.hasOld);
  if (applicable.length === 0) return null;
  const tpl = rng.pick(applicable);
  const { hasOld: _drop, ...use } = slots;
  return fillEvents(tpl.events, use, `${kind}/${family.id}`);
}

/** A filler of at most `room` events, not one already used in this session while an unused one fits. */
function fillerSegment(spec, rng, room, project, used) {
  const fits = spec.filler.map((f, i) => ({ f, i })).filter(({ f }) => f.events.length <= room);
  const fresh = fits.filter(({ i }) => !used.has(i));
  const { f, i } = rng.pick(fresh.length ? fresh : fits);
  used.add(i);
  return fillEvents(f.events, { proj: project }, "filler");
}

// ---------------------------------------------------------------- sessions

function renderSession(spec, index, date, kind, project, desc, segments, rng) {
  const target = rng.range(spec.minEvents, spec.maxEvents);
  // every session is SYSTEM, a USER opener (so each one has a user turn), then the content and fillers
  const opener = { role: ROLES.U, text: fill(rng.pick(spec.openers), { proj: project }, "openers") };
  let used = 2 + segments.reduce((n, s) => n + s.length, 0);
  if (used > spec.maxEvents) throw new Error(`session ${index + 1} (${date}, ${kind}) needs ${used} events, over the maximum of ${spec.maxEvents}`);
  const body = [...segments];
  const usedFillers = new Set();
  while (used < target) {
    const filler = fillerSegment(spec, rng, target - used, project, usedFillers);
    body.splice(rng.range(0, body.length), 0, filler);
    used += filler.length;
  }
  const events = [{ role: "SYSTEM", text: `Session date: ${date}. Project: ${project}, ${desc}.` }, opener, ...body.flat()];
  const id = `${spec.idPrefix}${pad(index + 1, 26 - spec.idPrefix.length)}`;
  const text =
    `TRANSCRIPT ${id} source=claude-code events=${events.length}\n\n` +
    events.map((e) => `${e.role}:\n${e.text}`).join("\n\n") +
    "\n";
  // a body line that looks like a label would change the event count the parser sees
  const labelLike = text.split("\n").filter((l) => /^(USER|ASSISTANT|SYSTEM|TOOL\b[^:\n]*):/.test(l));
  if (labelLike.length !== events.length) throw new Error(`session ${index + 1}: text contains a line that looks like an event label`);
  return { file: `${pad(index + 1, 2)}-${date}-${kind}.txt`, text };
}

/**
 * @param {object} spec parsed spec.json
 * @returns {{file:string, text:string}[]} transcripts in chronological order (file names carry the order, the date and the kind)
 */
export function generate(spec) {
  validateSpec(spec);
  const rng = makeRng(spec.seed);
  const families = spec.families;

  // fact sessions: one per distinct date
  const byDate = new Map();
  const at = (date) => {
    if (!byDate.has(date)) byDate.set(date, []);
    return byDate.get(date);
  };
  for (const f of families) f.values.forEach((v, i) => at(v.date).push({ family: f, index: i }));
  for (const lt of spec.longtail ?? []) at(lt.date).push({ longtail: lt });
  const sessions = [...byDate.keys()].sort().map((date) => ({ date, kind: "facts", items: byDate.get(date) }));

  // distractor sessions: random dates in the window; kinds that quote history only on dates that have history
  const start = dayNumber(spec.window.start);
  const end = dayNumber(spec.window.end);
  const mixTotal = Object.values(spec.distractorMix).reduce((a, b) => a + b, 0);
  const dates = Array.from({ length: mixTotal }, () => isoFromDay(rng.range(start, end))).sort();
  const hasHistory = (date) => families.some((f) => currentIndex(f, date) >= 1);
  const kinds = Object.entries(spec.distractorMix).flatMap(([kind, n]) => Array(n).fill(kind));
  const plain = rng.shuffle(kinds.filter((k) => !HISTORY_KINDS.has(k)));
  const history = kinds.filter((k) => HISTORY_KINDS.has(k));
  const early = dates.filter((d) => !hasHistory(d));
  if (early.length > plain.length) throw new Error(`${early.length} distractor dates have no history to quote but only ${plain.length} history-free kinds exist; change the seed or the mix`);
  const pool = rng.shuffle([...history, ...plain.slice(early.length)]);
  const assigned = new Map();
  let pi = 0;
  let ei = 0;
  for (const [i, date] of dates.entries()) assigned.set(i, hasHistory(date) ? pool[pi++] : plain[ei++]);
  dates.forEach((date, i) => sessions.push({ date, kind: assigned.get(i), items: null }));

  // stable chronological order: by date, fact sessions before distractors of the same day (sort is stable)
  sessions.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  return sessions.map((s, index) => {
    if (s.kind === "facts") {
      const segments = s.items.map((it) => (it.longtail ? longtailSegment(it.longtail) : statementSegment(spec, rng, it.family, it.index)));
      return renderSession(spec, index, s.date, "facts", spec.project, spec.projectDesc, segments, rng);
    }
    const other = s.kind === "other" ? rng.pick(spec.otherProjects) : null;
    const project = other ? other.name : spec.project;
    const desc = other ? other.desc : spec.projectDesc;
    const segments = [];
    const want = rng.range(2, 3);
    for (const family of rng.shuffle(families)) {
      if (segments.length >= want) break;
      const seg = distractorSegment(spec, rng, s.kind, family, s.date, other ? other.name : rng.pick(spec.otherProjects).name);
      if (!seg) continue;
      if (2 + segments.reduce((n, x) => n + x.length, 0) + seg.length > spec.maxEvents) continue; // SYSTEM + opener + content
      segments.push(seg);
    }
    if (segments.length === 0) throw new Error(`no ${s.kind} content for ${s.date}`);
    return renderSession(spec, index, s.date, s.kind, project, desc, segments, rng);
  });
}
