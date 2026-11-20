import { MAX_PART_CHARS } from "./split.js";

// ROUGH planning estimate, not a quote. It models the engine's own behaviour:
//  - text is ~4 characters per token;
//  - an analyzer part keeps its input in the conversation, and every turn
//    re-reads it (cache reads still count against the token budget);
//  - a typical analyzer takes ~4 turns, an organizer ~6 (calibrated on real runs, see below);
//  - each turn appends ~1,000 tokens of tool results and ~600 tokens of output.
// Real usage depends on the model, how many documents already exist and how
// much the agents decide to write; it can differ by 2x in either direction.
// Calibration (GPT-5.6 luna): 48 short inputs used 980k tokens (the first model said 3.96M); 5 to 9 short inputs used 135k to 252k.
// The actual figure is reported in the usage of the finished dream.

const CHARS_PER_TOKEN = 4;
const SYSTEM_AND_TOOLS_TOKENS = 2_500;
const ANALYZER_TURNS = 4;
const ORGANIZER_TURNS = 6;
const TURN_APPEND_TOKENS = 1_000;
const TURN_OUTPUT_TOKENS = 600;
const DOCS_SHARE_READ_BY_ANALYZER = 0.25;
const DOCS_GROWTH_PER_INPUT_CHAR = 0.15;

const tokens = (chars) => Math.ceil(chars / CHARS_PER_TOKEN);

/**
 * @param {{ transcripts: {chars:number}[], existingDocsBytes?: number }} args
 * @returns {{ transcripts:number, chars:number, est_total_tokens:number, notes:string[] }}
 */
export function estimateDream({ transcripts, existingDocsBytes = 0 }) {
  const list = Array.isArray(transcripts) ? transcripts : [];
  const docsTokens = tokens(Math.max(0, existingDocsBytes));
  let chars = 0;
  let total = 0;

  for (const t of list) {
    const c = Math.max(0, Number(t?.chars) || 0);
    chars += c;
    const parts = Math.max(1, Math.ceil(c / MAX_PART_CHARS));
    const perPartTokens = tokens(c / parts);
    for (let p = 0; p < parts; p++) {
      const fixed = SYSTEM_AND_TOOLS_TOKENS + perPartTokens;
      const growth = (ANALYZER_TURNS * (ANALYZER_TURNS + 1)) / 2 * TURN_APPEND_TOKENS;
      const docsRead = docsTokens * DOCS_SHARE_READ_BY_ANALYZER * (ANALYZER_TURNS / 2);
      total += ANALYZER_TURNS * fixed + growth + docsRead + ANALYZER_TURNS * TURN_OUTPUT_TOKENS;
    }
  }

  if (list.length > 0) {
    const docsAfter = docsTokens + tokens(chars) * DOCS_GROWTH_PER_INPUT_CHAR;
    const orgTurnsWithDocs = ORGANIZER_TURNS * 0.7;
    total +=
      ORGANIZER_TURNS * SYSTEM_AND_TOOLS_TOKENS +
      docsAfter * orgTurnsWithDocs +
      ((ORGANIZER_TURNS * (ORGANIZER_TURNS + 1)) / 2) * TURN_APPEND_TOKENS * 0.5 +
      ORGANIZER_TURNS * TURN_OUTPUT_TOKENS;
  }

  const notes = [
    "Rough estimate (order of magnitude, can be off by 2x): about 4 characters per token, ~4 turns per analyzer, ~6 for the organizer.",
    "Cache reads count against the budget, so large inputs cost more than their size: every turn re-reads the input.",
    "The real usage is reported on the dream once it has run.",
  ];
  if (list.some((t) => (Number(t?.chars) || 0) > MAX_PART_CHARS)) {
    notes.push(`Inputs over ${MAX_PART_CHARS.toLocaleString("en-US")} characters are split into parts that are analyzed one after another.`);
  }

  return {
    transcripts: list.length,
    chars,
    est_total_tokens: Math.round(total / 1000) * 1000,
    notes,
  };
}
