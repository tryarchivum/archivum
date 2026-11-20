// Zero-dependency seeded fuzzing helpers (shared by core and cli fuzz tests).
// Deterministic: ARCHIVUM_FUZZ_SEED fixes the base seed, ARCHIVUM_FUZZ_ITERS the iteration count (default 300).
// On failure the error message carries the exact seed of the failing iteration so it can be replayed with
//   ARCHIVUM_FUZZ_SEED=<seed> ARCHIVUM_FUZZ_ITERS=1 node --test <file>

export const ITERS = Math.max(1, Number.parseInt(process.env.ARCHIVUM_FUZZ_ITERS ?? "", 10) || 300);
export const BASE_SEED = Number.parseInt(process.env.ARCHIVUM_FUZZ_SEED ?? "", 10) || 0x5eed1234;

/** mulberry32: small, fast, good enough, fully deterministic. */
export function makeRng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const rng = {
    seed,
    next,
    /** integer in [lo, hi] inclusive */
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    chance: (p) => next() < p,
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    /** string of `len` characters drawn from `chars` (a string; iterated by code unit) */
    str: (chars, len) => {
      let s = "";
      for (let i = 0; i < len; i++) s += chars[Math.floor(next() * chars.length)];
      return s;
    },
    shuffle: (arr) => {
      const a2 = [...arr];
      for (let i = a2.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [a2[i], a2[j]] = [a2[j], a2[i]];
      }
      return a2;
    },
  };
  return rng;
}

/**
 * Runs `fn(rng, i)` `iters` times, each with its own seed. Any throw is rethrown with the seed attached.
 * @param {string} name
 * @param {(rng:ReturnType<typeof makeRng>, i:number)=>void} fn
 * @param {{iters?:number}} [opts]
 */
export function property(name, fn, { iters = ITERS } = {}) {
  for (let i = 0; i < iters; i++) {
    const seed = (BASE_SEED + i * 0x9e3779b1) >>> 0;
    try {
      fn(makeRng(seed), i);
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      const banner = `[fuzz property "${name}" failed: seed=${seed} (iteration ${i}); replay with ARCHIVUM_FUZZ_SEED=${seed} ARCHIVUM_FUZZ_ITERS=1]`;
      err.message = `${banner}\n${err.message}`;
      if (typeof err.stack === "string") err.stack = `${banner}\n${err.stack}`;
      throw err;
    }
  }
}

const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
export const CHARSETS = {
  alnum: ALNUM,
  upperDigit: "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
  b64url: `${ALNUM}_-`,
  b64: `${ALNUM}+/=`,
  word: `${ALNUM}_`,
};

const UNICODE_LETTERS = ["é", "ü", "ß", "ñ", "я", "Ж", "中", "文", "日本語", "한", "α", "β", "ع", "א", "😀", "🔑", "𝔘", "ı", "İ", "ǅ", "\u0301", "\u200b", "\u00a0"];

/** Letters/digits/unicode only: never contains characters that a secret pattern accepts as a token body (`-`, `_`, `.`, ...) next to ASCII. */
export function plainWord(rng) {
  if (rng.chance(0.3)) return rng.pick(UNICODE_LETTERS);
  const n = rng.int(1, 8);
  return rng.str(ALNUM, n);
}

const SEPARATORS = [" ", "  ", "\n", "\r\n", "\t", ", ", "; ", ": ", " (", ") ", " \"", "\" ", " '", "' ", "! ", "? ", " / ", " | ", " * ", " # ", " @ ", " & ", "\n\n", " ~ ", " < ", " > ", " { ", " } ", " [ ", " ] ", " = ", "\\", "\u2028", "\u2014 "];

/** Random prose: words joined by separators that contain no `[A-Za-z0-9_-]` character. */
export function plainText(rng, maxWords = 12) {
  const n = rng.int(0, maxWords);
  let s = "";
  for (let i = 0; i < n; i++) s += plainWord(rng) + rng.pick(SEPARATORS);
  if (rng.chance(0.1)) s += "[REDACTED:openai_key] ";
  return s;
}

/** Fully arbitrary string: any code unit, including lone surrogates and NULs. */
export function anyString(rng, maxLen = 40) {
  const n = rng.int(0, maxLen);
  let s = "";
  for (let i = 0; i < n; i++) {
    const r = rng.next();
    if (r < 0.5) s += String.fromCharCode(rng.int(32, 126));
    else if (r < 0.6) s += rng.pick(["\n", "\r", "\r\n", "\t", "\0", "\\", '"', "'", "/", "."]);
    else if (r < 0.75) s += String.fromCharCode(rng.int(0xd800, 0xdfff)); // lone (or accidentally paired) surrogates
    else if (r < 0.9) s += String.fromCharCode(rng.int(0x80, 0xd7ff));
    else s += rng.pick(UNICODE_LETTERS);
  }
  return s;
}

/** Measures one call in ms. */
export function timeMs(fn) {
  const t = performance.now();
  const value = fn();
  return { ms: performance.now() - t, value };
}

/**
 * Is `run(size)` linear in `size`? Absolute budgets ("under 50 ms") fail on a busy CI box or a shared VPS without any bug, so
 * this compares the cost at size N with the cost at size 4N instead: linear work grows about 4x, quadratic about 16x, and
 * machine speed cancels out. Each side is the median of `reps` runs after a warm-up; a noisy run is retried, because a real
 * slowdown shows every time and a scheduling hiccup does not.
 * @returns {{ratio: number, small: number, large: number}} the best (lowest) ratio over the attempts
 */
export function growthRatio(run, size, { reps = 5, attempts = 3 } = {}) {
  const median = (n) => {
    const xs = Array.from({ length: reps }, () => timeMs(() => run(n)).ms).sort((a, b) => a - b);
    return xs[Math.floor(xs.length / 2)];
  };
  run(Math.max(1, Math.floor(size / 4))); // warm-up (regex / JIT compilation)
  let best = { ratio: Infinity, small: 0, large: 0 };
  for (let i = 0; i < attempts; i++) {
    const small = Math.max(median(size), 0.05); // floor: below 50 us the clock is noise
    const large = median(size * 4);
    const ratio = large / small;
    if (ratio < best.ratio) best = { ratio, small, large };
    if (best.ratio < 9) break;
  }
  return best;
}

/** JSON-ish rendering with every non-printable-ASCII code unit escaped, so failures are copy-pasteable. */
export function show(s) {
  return String(JSON.stringify(s)).replace(/[^\x20-\x7e]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}
