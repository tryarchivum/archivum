// Deterministic, high-precision secret scrubber. Applied to transcripts at
// ingestion and to everything a dream writes. Order matters: specific key
// formats run before generic ones (sk-ant- before sk-, JWT before Bearer).
// Replacement is idempotent: "[REDACTED:kind]" matches none of the patterns.

// Private keys are not a single regex: "BEGIN ... lazily up to END" rescans the rest of the text for every
// unterminated BEGIN, which is quadratic (2.7 s for 200 KB of repeated headers). redactPrivateKeys scans once.
const PEM_BEGIN = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/g;
const PEM_END = /-----END [A-Z0-9 ]*PRIVATE KEY-----/g;
const PEM_BODY = /(?:\r?\n[A-Za-z0-9+/=]{16,})+/y;

/** Replaces BEGIN..END blocks, or a header followed by base64 lines when the END is missing (truncated). */
function redactPrivateKeys(text, replacement) {
  let out = "";
  let pos = 0;
  let hit = 0;
  let noEnd = false; // once an END is missing after a header, it is missing after every later one
  PEM_BEGIN.lastIndex = 0;
  for (let m = PEM_BEGIN.exec(text); m; m = PEM_BEGIN.exec(text)) {
    const bodyStart = m.index + m[0].length;
    let end = -1;
    if (!noEnd) {
      PEM_END.lastIndex = bodyStart;
      const e = PEM_END.exec(text);
      if (e) end = e.index + e[0].length;
      else noEnd = true;
    }
    if (end < 0) {
      PEM_BODY.lastIndex = bodyStart;
      const b = PEM_BODY.exec(text);
      if (!b) continue;
      end = bodyStart + b[0].length;
    }
    out += text.slice(pos, m.index) + replacement;
    pos = end;
    hit++;
    PEM_BEGIN.lastIndex = end;
  }
  return hit === 0 ? { text, hit } : { text: out + text.slice(pos), hit };
}

const PATTERNS = [
  ["private_key", null],
  ["anthropic_key", /sk-ant-[\w-]{20,}/g],
  ["openai_key", /sk-[A-Za-z0-9_-]{20,}/g],
  ["archivum_key", /\barc_[A-Za-z0-9_-]{32,}/g],
  ["aws_access_key", /\bAKIA[0-9A-Z]{16,}/g],
  ["github_token", /\bgh[pousr]_[A-Za-z0-9]{36,}/g],
  ["npm_token", /\bnpm_[A-Za-z0-9]{36}\b/g],
  ["slack_token", /\bxox[baprs]-[A-Za-z0-9-]{10,}/g],
  ["google_api_key", /\bAIza[0-9A-Za-z_-]{35}/g],
  ["jwt", /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g],
  ["bearer_token", /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/g],
];

/**
 * @param {string} text
 * @returns {{text:string, count:number, kinds:string[]}} `count` replacements, distinct `kinds`
 */
export function scrubSecrets(text) {
  let out = String(text);
  let count = 0;
  const kinds = [];
  for (const [kind, re] of PATTERNS) {
    let hit = 0;
    if (re === null) {
      const r = redactPrivateKeys(out, `[REDACTED:${kind}]`);
      out = r.text;
      hit = r.hit;
    } else {
      out = out.replace(re, () => {
        hit++;
        return `[REDACTED:${kind}]`;
      });
    }
    if (hit > 0) {
      count += hit;
      kinds.push(kind);
    }
  }
  return { text: out, count, kinds };
}
