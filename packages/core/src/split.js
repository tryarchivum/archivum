// Splits large inputs into parts of at most MAX_PART_CHARS characters.
// Prefers event boundaries (blank lines between rendered events), then line
// boundaries, and only cuts mid-line when a single line exceeds the limit.

export const MAX_PART_CHARS = 120_000;

function hardSplit(block, max) {
  const pieces = [];
  let rest = block;
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n", max);
    let skip = 1;
    if (cut < max / 2) {
      cut = max;
      skip = 0;
      const code = rest.charCodeAt(cut - 1);
      if (code >= 0xd800 && code <= 0xdbff) cut -= 1; // do not split a surrogate pair
    }
    pieces.push(rest.slice(0, cut));
    rest = rest.slice(cut + skip);
  }
  if (rest.length) pieces.push(rest);
  return pieces;
}

/** @returns {string[]} always at least one part; every part is <= max chars */
export function splitText(text, max = MAX_PART_CHARS) {
  if (text.length <= max) return [text];
  const parts = [];
  let cur = "";
  for (const block of text.split("\n\n")) {
    for (const piece of block.length > max ? hardSplit(block, max) : [block]) {
      if (cur === "") cur = piece;
      else if (cur.length + 2 + piece.length <= max) cur += `\n\n${piece}`;
      else {
        parts.push(cur);
        cur = piece;
      }
    }
  }
  if (cur !== "") parts.push(cur);
  return parts;
}
