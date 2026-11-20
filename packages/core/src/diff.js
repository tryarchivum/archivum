// Document-level and line-level diffs (pure, deterministic).

/**
 * @param {Record<string,string>} before
 * @param {Record<string,string>} after
 * @returns {{path:string, kind:"added"|"modified"|"removed", before:string|null, after:string|null}[]} sorted by path
 */
export function diffDocs(before = {}, after = {}) {
  const out = [];
  const paths = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const path of [...paths].sort()) {
    const a = Object.hasOwn(before, path) ? before[path] : null;
    const b = Object.hasOwn(after, path) ? after[path] : null;
    if (a === null) out.push({ path, kind: "added", before: null, after: b });
    else if (b === null) out.push({ path, kind: "removed", before: a, after: null });
    else if (a !== b) out.push({ path, kind: "modified", before: a, after: b });
  }
  return out;
}

const toLines = (s) => (s === "" ? [] : (s.endsWith("\n") ? s.slice(0, -1) : s).split("\n"));

const MAX_LCS_CELLS = 16_000_000;

/**
 * Line diff by longest common subsequence. Nothing is collapsed: every line of
 * both inputs appears (as "same", "del" or "add"). A single trailing newline is
 * not a line. Common head/tail lines are trimmed first; when the remaining
 * middle is huge (> 16M cells) it degrades to "all deleted, then all added".
 * @returns {{type:"same"|"add"|"del", text:string}[]}
 */
export function lineDiff(a, b) {
  const A = toLines(String(a ?? ""));
  const B = toLines(String(b ?? ""));
  let head = 0;
  while (head < A.length && head < B.length && A[head] === B[head]) head++;
  let tail = 0;
  while (tail < A.length - head && tail < B.length - head && A[A.length - 1 - tail] === B[B.length - 1 - tail]) tail++;
  const out = [];
  for (let i = 0; i < head; i++) out.push({ type: "same", text: A[i] });

  const am = A.slice(head, A.length - tail);
  const bm = B.slice(head, B.length - tail);
  const n = am.length;
  const m = bm.length;
  if (n === 0 || m === 0 || (n + 1) * (m + 1) > MAX_LCS_CELLS) {
    for (const t of am) out.push({ type: "del", text: t });
    for (const t of bm) out.push({ type: "add", text: t });
  } else {
    const w = m + 1;
    const dp = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i * w + j] = am[i] === bm[j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (am[i] === bm[j]) {
        out.push({ type: "same", text: am[i] });
        i++;
        j++;
      } else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) {
        out.push({ type: "del", text: am[i++] });
      } else {
        out.push({ type: "add", text: bm[j++] });
      }
    }
    while (i < n) out.push({ type: "del", text: am[i++] });
    while (j < m) out.push({ type: "add", text: bm[j++] });
  }
  for (let i = A.length - tail; i < A.length; i++) out.push({ type: "same", text: A[i] });
  return out;
}
