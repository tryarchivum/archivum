// The CLI imports the core library through this file only.
//   published package: ../vendor/core (copied in by scripts/vendor-core.mjs when packing; there is no archivum-core dependency)
//   repo checkout:     ../../core/src  (the single source of truth, also bundled for the browser by the /try/ simulation)
let mod;
try {
  mod = await import("../vendor/core/index.js");
} catch (e) {
  if (e?.code !== "ERR_MODULE_NOT_FOUND" && e?.code !== "ENOENT") throw e;
  mod = await import(new URL("../../core/src/index.js", import.meta.url).href);
}

export const {
  sha256Hex,
  scrubSecrets,
  MemoryWiki,
  diffDocs,
  lineDiff,
  buildContext,
  searchCorpus,
  buildCorpus,
  renderTranscript,
  renderNotes,
  runDream,
  estimateDream,
  newId,
  tokenize,
  claudeCodeJsonlToEvents,
  ompJsonlToEvents,
} = mod;
