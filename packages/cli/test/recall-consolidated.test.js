import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { recallResults } from "../src/memory.js";
import { Store } from "../src/store.js";

test("notes already folded into the wiki do not outrank the wiki page", () => {
  const home = mkdtempSync(join(tmpdir(), "arc-recall-"));
  try {
    const store = Store.open({ space: "t", env: { ARCHIVUM_HOME: home } });
    const old = store.appendNote("quillon: tests need QUILLON_HOME exported");
    store.writeDoc("/quillon.md", "---\nname: quillon\ndescription: tests\n---\nSince 0.4.0 QUILLON_HOME is not needed to run tests.\n");
    // before any dream has consolidated notes, the note is still recalled
    assert.ok(recallResults(store, "QUILLON_HOME tests").some((r) => r.kind === "note"));
    store.writeState({ notes_consolidated_through: old.ts });
    const after = recallResults(store, "QUILLON_HOME tests");
    assert.ok(after.length > 0);
    assert.ok(after.every((r) => r.kind === "wiki"), JSON.stringify(after));
    // a newer note is still recalled
    const fresh = new Date(Date.parse(old.ts) + 5000).toISOString();
    store.appendNote("quillon: new CI runner is ubuntu-24");
    const notes = store.readNotes();
    assert.equal(notes.length, 2);
    assert.ok(notes[1].ts > old.ts || fresh > old.ts);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
