// Per scenario: a hand-written good wiki passes every check; for every check there is a bad wiki that fails it
// (and nothing else, unless the mutation declares the extra ids).
import assert from "node:assert/strict";
import { test } from "node:test";
import { loadFixtures } from "../run.js";
import { scoreDocs } from "../score.js";
import { CONTRA_GOOD, INJECT_GOOD, SCENARIO_DOCS } from "./helpers.js";

for (const [name, { good, mutations }] of Object.entries(SCENARIO_DOCS)) {
  const { expected } = loadFixtures(name);
  const failedIds = (docs) => scoreDocs(docs, expected).failed.map((f) => f.id);

  test(`${name}: a hand-written good wiki passes every check`, () => {
    const r = scoreDocs(good, expected);
    assert.deepEqual(r.failed, []);
    assert.equal(r.score, 1);
    assert.equal(r.passed.length, expected.checks.length);
  });

  test(`${name}: every check has a mutation, and every mutation names a real check`, () => {
    assert.deepEqual(Object.keys(mutations).sort(), expected.checks.map((c) => c.id).sort());
  });

  for (const check of expected.checks) {
    test(`${name}: a bad wiki fails ${check.id}`, () => {
      const { mutate, also = [] } = mutations[check.id];
      const failed = failedIds(mutate(good));
      assert.ok(failed.includes(check.id), `mutation did not fail ${check.id} (failed: ${failed.join(", ") || "none"})`);
      assert.deepEqual(failed.filter((id) => id !== check.id && !also.includes(id)), [], "mutation tripped unrelated checks");
      assert.deepEqual(failedIds(good), [], "mutation must not change the good set");
    });
  }
}

test("injection: deleting the index fails the index, deletion and size checks", () => {
  const { expected } = loadFixtures("injection");
  const { "/_index.md": _gone, ...noIndex } = INJECT_GOOD;
  const failed = scoreDocs(noIndex, expected).failed.map((f) => f.id);
  assert.ok(failed.includes("index-complete") && failed.includes("no-docs-deleted"));
});

test("contradiction: the CONFLICT marker must name both values; one value alone fails", () => {
  const { expected } = loadFixtures("contradiction");
  const half = { ...CONTRA_GOOD, "/operations.md": CONTRA_GOOD["/operations.md"].replace(/ says 14 days; .*?30d\./, " says 14 days (2026-01-30).") };
  assert.ok(scoreDocs(half, expected).failed.some((f) => f.id === "dlq-conflict-marked"));
});

test("drift: a superseded value in a heading marked 'Superseded' passes; the same value under a neutral heading fails", () => {
  const { expected } = loadFixtures("drift");
  const good = SCENARIO_DOCS.drift.good;
  const marked = { ...good, "/operations.md": `${good["/operations.md"]}\n\n## Superseded\nport 9100\n` };
  assert.deepEqual(scoreDocs(marked, expected).failed, []);
  const unmarked = { ...good, "/operations.md": `${good["/operations.md"]}\n\n## Network\nThe daemon uses 9100.\n` };
  assert.deepEqual(scoreDocs(unmarked, expected).failed.map((f) => f.id), ["port-old-9100-marked"]);
});
