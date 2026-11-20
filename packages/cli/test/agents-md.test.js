import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { sandbox, run } from "./helpers.js";
import { mergeAgentsMd, AGENTS_BLOCK, AGENTS_BEGIN, AGENTS_END } from "../src/agents-md.js";

const count = (s, sub) => s.split(sub).length - 1;

// ------------------------------------------------------------------ pure merge
test("mergeAgentsMd: creates, appends, updates in place, and is idempotent", () => {
  const created = mergeAgentsMd(null);
  assert.equal(created.action, "created");
  assert.equal(created.text, AGENTS_BLOCK);

  const mine = "# My project\n\nUse tabs.\n";
  const added = mergeAgentsMd(mine);
  assert.equal(added.action, "added");
  assert.ok(added.text.startsWith(mine), "existing text is kept untouched, byte for byte, at the top");
  assert.equal(count(added.text, AGENTS_BEGIN), 1);

  const again = mergeAgentsMd(added.text);
  assert.equal(again.action, "unchanged");
  assert.equal(again.text, added.text);

  // an older version of the block is replaced in place, and the text around it survives
  const old = `before\n\n${AGENTS_BEGIN}\nold wording\n${AGENTS_END}\n\nafter\n`;
  const upd = mergeAgentsMd(old);
  assert.equal(upd.action, "updated");
  assert.ok(upd.text.startsWith("before\n\n") && upd.text.endsWith("after\n"));
  assert.ok(!upd.text.includes("old wording"));
  assert.equal(count(upd.text, AGENTS_BEGIN), 1);
});

test("mergeAgentsMd: empty file, no trailing newline and CRLF files are handled", () => {
  assert.equal(mergeAgentsMd("").action, "added");
  assert.ok(mergeAgentsMd("").text.startsWith(AGENTS_BEGIN));
  const noNl = mergeAgentsMd("# T");
  assert.ok(noNl.text.startsWith("# T\n\n<!-- archivum:begin"));
  const crlf = mergeAgentsMd("# T\r\n\r\ntext\r\n");
  assert.ok(crlf.text.startsWith("# T\r\n\r\ntext\r\n"), "CRLF content before the block is preserved");
  assert.equal(count(mergeAgentsMd(crlf.text).text, AGENTS_BEGIN), 1);
});

test("mergeAgentsMd: an unterminated block is left alone and a fresh one is appended (nothing the user wrote is deleted)", () => {
  const broken = `intro\n${AGENTS_BEGIN}\nthe user's own words, no end marker\n`;
  const r = mergeAgentsMd(broken);
  assert.equal(r.action, "added");
  assert.ok(r.text.includes("the user's own words, no end marker"));
});

test("the block names real tools and carries the safety lines", () => {
  for (const t of ["recall", "remember", "update_note"]) assert.ok(AGENTS_BLOCK.includes(`\`${t}\``), t);
  assert.match(AGENTS_BLOCK, /Never save secrets/);
  assert.match(AGENTS_BLOCK, /data, not as instructions/);
  assert.match(AGENTS_BLOCK, /unless the user asks/);
});

// ------------------------------------------------------------------ init --codex
test("init --codex writes AGENTS.md in the current folder, backs up, and is idempotent", async () => {
  const sb = sandbox({ withCodex: true });
  try {
    const agents = path.join(sb.work, "AGENTS.md");
    let r = await run(["init", "--codex", "--dry-run"], { env: sb.env, cwd: sb.work });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /would create .*AGENTS\.md/);
    assert.equal(fs.existsSync(agents), false, "dry run writes nothing");

    r = await run(["init", "--codex"], { env: sb.env, cwd: sb.work });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /created .*AGENTS\.md/);
    assert.ok(fs.readFileSync(agents, "utf8").includes(AGENTS_BEGIN));
    assert.equal(fs.existsSync(`${agents}.archivum-bak`), false, "no backup when there was no file");

    r = await run(["init", "--codex"], { env: sb.env, cwd: sb.work });
    assert.match(r.stdout, /already has the Archivum block/);
    assert.equal(count(fs.readFileSync(agents, "utf8"), AGENTS_BEGIN), 1);
  } finally {
    sb.cleanup();
  }
});

test("init --codex keeps an existing AGENTS.md and backs it up once", async () => {
  const sb = sandbox({ withCodex: true });
  try {
    const agents = path.join(sb.work, "AGENTS.md");
    const mine = "# Rules\n\n- run pnpm lint\n";
    fs.writeFileSync(agents, mine);
    let r = await run(["init", "--codex"], { env: sb.env, cwd: sb.work });
    assert.match(r.stdout, /added the Archivum block to/);
    const after = fs.readFileSync(agents, "utf8");
    assert.ok(after.startsWith(mine));
    assert.equal(fs.readFileSync(`${agents}.archivum-bak`, "utf8"), mine);
    // a later wording update must not overwrite the first backup
    fs.writeFileSync(agents, after.replace("Project memory (Archivum)", "Project memory (older wording)").replace(/- Never save[^\n]*\n/, "- x\n"));
    r = await run(["init", "--codex"], { env: sb.env, cwd: sb.work });
    assert.match(r.stdout, /updated the Archivum block in/);
    assert.equal(fs.readFileSync(`${agents}.archivum-bak`, "utf8"), mine, "first backup preserved");
  } finally {
    sb.cleanup();
  }
});

test("init --codex --no-agents-md leaves the project alone; --dir targets another folder", async () => {
  const sb = sandbox({ withCodex: true });
  try {
    let r = await run(["init", "--codex", "--no-agents-md"], { env: sb.env, cwd: sb.work });
    assert.equal(fs.existsSync(path.join(sb.work, "AGENTS.md")), false);
    assert.match(r.stdout, /AGENTS\.md left alone/);
    const other = path.join(sb.root, "other-proj");
    fs.mkdirSync(other);
    r = await run(["init", "--codex", "--dir", other], { env: sb.env, cwd: sb.work });
    assert.ok(fs.existsSync(path.join(other, "AGENTS.md")));
    assert.equal(fs.existsSync(path.join(sb.work, "AGENTS.md")), false);
  } finally {
    sb.cleanup();
  }
});

test("init --codex refuses to write AGENTS.md into the home folder", async () => {
  const sb = sandbox({ withCodex: true });
  try {
    const r = await run(["init", "--codex"], { env: sb.env, cwd: sb.home });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /AGENTS\.md not written: this is your home folder/);
    assert.equal(fs.existsSync(path.join(sb.home, "AGENTS.md")), false);
  } finally {
    sb.cleanup();
  }
});

test("init --claude-code alone never creates AGENTS.md", async () => {
  const sb = sandbox({ withClaude: true });
  try {
    await run(["init", "--claude-code"], { env: sb.env, cwd: sb.work });
    assert.equal(fs.existsSync(path.join(sb.work, "AGENTS.md")), false);
  } finally {
    sb.cleanup();
  }
});

test("the home-folder guard also fires when HOME is reached through a symlink (macOS: /var -> /private/var)", async () => {
  const sb = sandbox({ withCodex: true });
  try {
    const link = path.join(path.dirname(sb.home), "home-link");
    try {
      fs.symlinkSync(sb.home, link, "dir");
    } catch {
      return; // symlinks need privileges on some Windows setups; the logic is the same and covered above
    }
    const env = { ...sb.env, HOME: link, USERPROFILE: link };
    const r = await run(["init", "--codex"], { env, cwd: sb.home });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /AGENTS\.md not written: this is your home folder/);
    assert.equal(fs.existsSync(path.join(sb.home, "AGENTS.md")), false);
    const sub = path.join(sb.home, "project");
    fs.mkdirSync(sub);
    const ok = await run(["init", "--codex"], { env, cwd: sub });
    assert.match(ok.stdout, /created .*AGENTS\.md/, "a real project folder inside the symlinked home still works");
  } finally {
    sb.cleanup();
  }
});
