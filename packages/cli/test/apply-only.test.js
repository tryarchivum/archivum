import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Store } from "../src/store.js";
import { callTool } from "../src/mcp.js";
import { applyProposal, pendingChanges, proposalChanges, rejectProposal, renderProposalDiff, parseOnly } from "../src/proposals.js";

// Apply a dream page by page. The owner saw a dream propose three pages, one with a line nobody said; all-or-nothing forced a choice.
const bin = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "archivum.js");
const out = (r) => r.content[0].text;
const FM = (slug, desc) => `---\nname: ${slug}\ndescription: ${desc}\n---\n`;

function tmp() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "arch-perpage-"));
  const store = new Store(root, "t");
  return { root, store, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

/** A pending transcript, a note, and a submitted dream with three pages. */
function threePageProposal(store) {
  store.appendNote("tests: run `make qa-all`");
  store.saveTranscript({
    id: "tr_1", source: "claude-code", status: "pending",
    events: [{ role: "user", content: "we deploy with deploy.sh and test with make qa-all" }, { role: "assistant", content: "noted" }],
    created_at: "2026-11-01T00:00:00.000Z", updated_at: "2026-11-01T00:00:00.000Z",
  });
  const id = /Draft id: (\S+)/.exec(out(callTool(store, "dream_prepare")))[1];
  const r = callTool(store, "dream_submit", {
    id, summary: "three pages",
    documents: [
      { path: "/_index.md", content: "## ops\n[[deploys]] - deploy rules\n[[testing]] - how to test\n" },
      { path: "/deploys.md", content: `${FM("deploys", "when deploying")}Run \`bash deploy.sh\`. [[testing]]\n` },
      { path: "/testing.md", content: `${FM("testing", "when testing")}Run \`make qa-all\`. [[deploys]]\n` },
    ],
  });
  assert.ok(!r.isError, out(r));
  return { id, proposal: () => store.listProposals().find((p) => p.id === id) };
}

test("parseOnly: comma list, missing slash, array, duplicates", () => {
  assert.deepEqual(parseOnly("/a.md,b.md , /a.md"), ["/a.md", "/b.md"]);
  assert.deepEqual(parseOnly(["/a.md", "b.md,c.md"]), ["/a.md", "/b.md", "/c.md"]);
  assert.deepEqual(parseOnly(""), []);
  assert.deepEqual(parseOnly(undefined), []);
});

test("apply --only writes just the chosen pages; the proposal stays in review and the inputs stay pending", () => {
  const { store, cleanup } = tmp();
  try {
    const { id, proposal } = threePageProposal(store);
    assert.equal(pendingChanges(store, id).length, 3);
    const r = applyProposal(store, proposal(), { only: "/deploys.md" });
    assert.deepEqual(r.applied, ["/deploys.md"]);
    assert.deepEqual(r.remaining.sort(), ["/_index.md", "/testing.md"]);
    assert.equal(r.status, "review");
    assert.match(store.readDoc("/deploys.md"), /deploy\.sh/);
    assert.equal(store.readDoc("/testing.md"), null, "an unchosen page is not written");
    assert.equal(store.listTranscripts()[0].status, "pending", "inputs are consumed only when the proposal is finished");
    assert.equal(store.readState().notes_consolidated_through, null);
    assert.equal(proposal().status, "review");
    assert.deepEqual(proposal().applied_paths, ["/deploys.md"]);
  } finally { cleanup(); }
});

test("a second apply --only takes another page; the last page finishes the proposal and consumes the inputs", () => {
  const { store, cleanup } = tmp();
  try {
    const { id, proposal } = threePageProposal(store);
    applyProposal(store, proposal(), { only: "/deploys.md" });
    applyProposal(store, proposal(), { only: "testing.md" });
    assert.equal(proposal().status, "review", "one page is still waiting");
    const last = applyProposal(store, proposal(), { only: "/_index.md" });
    assert.equal(last.status, "applied");
    assert.equal(proposal().status, "applied");
    assert.deepEqual(proposal().applied_paths.sort(), ["/_index.md", "/deploys.md", "/testing.md"]);
    assert.equal(store.listTranscripts()[0].status, "dreamed");
    assert.ok(store.readState().notes_consolidated_through);
    assert.equal(pendingChanges(store, id).length, 0);
  } finally { cleanup(); }
});

test("apply with no --only still applies everything, as before", () => {
  const { store, cleanup } = tmp();
  try {
    const { proposal } = threePageProposal(store);
    const r = applyProposal(store, proposal());
    assert.equal(r.applied.length, 3);
    assert.equal(r.status, "applied");
    assert.equal(store.listTranscripts()[0].status, "dreamed");
  } finally { cleanup(); }
});

test("a path that is not part of the proposal is refused, nothing is written", () => {
  const { store, cleanup } = tmp();
  try {
    const { proposal } = threePageProposal(store);
    assert.throws(() => applyProposal(store, proposal(), { only: "/pwn.md" }), /not a pending change/);
    assert.throws(() => applyProposal(store, proposal(), { only: "/deploys.md,/../etc/passwd" }), /not a pending change/);
    assert.throws(() => applyProposal(store, proposal(), { only: "," }), /needs at least one path/);
    assert.equal(store.wikiCount(), 0, "a refused request writes nothing, not even its valid half");
  } finally { cleanup(); }
});

test("a page applied earlier cannot be chosen again; the diff marks it", () => {
  const { store, cleanup } = tmp();
  try {
    const { proposal } = threePageProposal(store);
    applyProposal(store, proposal(), { only: "/deploys.md" });
    assert.throws(() => applyProposal(store, proposal(), { only: "/deploys.md" }), /not a pending change/);
    const diff = renderProposalDiff(store, proposal());
    assert.match(diff, /=== \/deploys\.md \(added\)\s+\[already applied\]/);
    assert.match(diff, /=== \/testing\.md \(added\)\n--- \/dev\/null/, "pending pages still show their diff");
  } finally { cleanup(); }
});

test("a page whose live file changed after the dream is skipped, even with --only; --force overrides", () => {
  const { store, cleanup } = tmp();
  try {
    store.writeDoc("/deploys.md", `${FM("deploys", "old")}live text written by hand\n`, { actor: "user" });
    store.appendNote("deploy via deploy.sh");
    store.saveTranscript({ id: "tr_2", source: "claude-code", status: "pending", events: [{ role: "user", content: "deploy with deploy.sh" }], created_at: "2026-11-02T00:00:00.000Z", updated_at: "2026-11-02T00:00:00.000Z" });
    const id = /Draft id: (\S+)/.exec(out(callTool(store, "dream_prepare")))[1];
    callTool(store, "dream_submit", { id, summary: "s", documents: [{ path: "/deploys.md", content: `${FM("deploys", "new")}Run deploy.sh\n` }, { path: "/_index.md", content: "## ops\n[[deploys]] - deploys\n" }] });
    store.writeDoc("/deploys.md", `${FM("deploys", "old")}edited again after the dream\n`, { actor: "user" });
    const p = () => store.listProposals().find((x) => x.id === id);
    const r = applyProposal(store, p(), { only: "/deploys.md" });
    assert.equal(r.applied.length, 0);
    assert.equal(r.skipped.length, 1);
    assert.match(store.readDoc("/deploys.md"), /edited again after the dream/);
    const forced = applyProposal(store, p(), { only: "/deploys.md", force: true });
    assert.deepEqual(forced.applied, ["/deploys.md"]);
  } finally { cleanup(); }
});

test("reject after a partial apply: applied pages stay, the rest is rejected, inputs are marked dreamed", () => {
  const { store, cleanup } = tmp();
  try {
    const { proposal } = threePageProposal(store);
    applyProposal(store, proposal(), { only: "/deploys.md" });
    const res = rejectProposal(store, proposal());
    assert.deepEqual(res.kept, ["/deploys.md"]);
    assert.deepEqual(res.rejected.sort(), ["/_index.md", "/testing.md"]);
    assert.equal(proposal().status, "rejected");
    assert.match(store.readDoc("/deploys.md"), /deploy\.sh/, "the applied page stays");
    assert.equal(store.readDoc("/testing.md"), null);
    assert.equal(store.listTranscripts()[0].status, "dreamed", "part of this dream was accepted");
  } finally { cleanup(); }
});

test("reject with nothing applied keeps the inputs pending, as before", () => {
  const { store, cleanup } = tmp();
  try {
    const { proposal } = threePageProposal(store);
    const res = rejectProposal(store, proposal());
    assert.deepEqual(res.kept, []);
    assert.equal(store.listTranscripts()[0].status, "pending");
  } finally { cleanup(); }
});

test("CLI: apply --only prints what is left and how to continue; proposals counts only pending pages", () => {
  const { root, store, cleanup } = tmp();
  try {
    const { id } = threePageProposal(store);
    const env = { ...process.env, ARCHIVUM_HOME: root, ARCHIVUM_SPACE: "t" };
    const run = (...args) => spawnSync(process.execPath, [bin, ...args], { env, encoding: "utf8" });
    const a = run("apply", id, "--only", "/deploys.md");
    assert.equal(a.status, 0, a.stderr);
    assert.match(a.stdout, /Applied 1 path\(s\)/);
    assert.match(a.stdout, /2 page\(s\) still under review: .*\/testing\.md/);
    assert.match(a.stdout, /apply .* --only <path>/);
    assert.match(run("proposals").stdout, /review\s+.*2 change\(s\)/);
    const bad = run("apply", id, "--only", "/nope.md");
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /not a pending change/);
    const noValue = run("apply", id, "--only");
    assert.notEqual(noValue.status, 0);
    const rj = run("reject", id);
    assert.equal(rj.status, 0, rj.stderr);
    assert.match(rj.stdout, /Rejected the remaining 2 page\(s\).*already applied stay/);
  } finally { cleanup(); }
});

test("the MCP review hint tells the agent about --only, and still says never to apply", () => {
  const { store, cleanup } = tmp();
  try {
    store.appendNote("a fact to dream about with enough words");
    const id = /Draft id: (\S+)/.exec(out(callTool(store, "dream_prepare")))[1];
    const t = out(callTool(store, "dream_submit", { id, summary: "s", documents: [{ path: "/_index.md", content: "## x\n" }] }));
    assert.match(t, /--only/);
    assert.match(t, /Never run apply yourself/);
  } finally { cleanup(); }
});
