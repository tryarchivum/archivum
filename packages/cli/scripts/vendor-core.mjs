// Bundles packages/core/src into this package so `npm i archivums` is ONE package with no archivum-core dependency.
// prepack: copy packages/core/src -> vendor/core.   postpack (--clean): remove it again.
// Source of truth stays packages/core/src (it must remain isomorphic: the /try/ simulation bundles it for the browser).
// The copy exists only while `npm pack` / `npm publish` runs, and is git-ignored, so a stale copy can never shadow the source.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(here, "../../core/src");
const DEST = path.resolve(here, "../vendor/core");

if (process.argv.includes("--clean")) {
  fs.rmSync(path.resolve(here, "../vendor"), { recursive: true, force: true });
  process.exit(0);
}

if (!fs.existsSync(path.join(SRC, "index.js"))) {
  console.error(`vendor-core: ${SRC}/index.js not found; run this from a checkout that has packages/core`);
  process.exit(1);
}
fs.rmSync(path.resolve(here, "../vendor"), { recursive: true, force: true });
fs.mkdirSync(DEST, { recursive: true });
fs.cpSync(SRC, DEST, { recursive: true });
fs.writeFileSync(
  path.join(DEST, "GENERATED.txt"),
  "Copied from packages/core/src by packages/cli/scripts/vendor-core.mjs when this package was packed. Do not edit here.\n",
);
let n = 0;
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) (e.isDirectory() ? walk(path.join(d, e.name)) : n++);
})(DEST);
console.error(`vendor-core: copied ${n} files into vendor/core`);
