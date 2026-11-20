import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { validatePath } from "../../core/src/index.js";
import { ITERS, anyString, plainText, property, show } from "../../core/test/_fuzz.js";
import { UsageError } from "../src/errors.js";
import { Store, assertDocPath, isDocPath, isSafeId, resolveSpace, sanitizeSpace } from "../src/store.js";

// Real file I/O (and Windows Defender) is slow: cap the iterations of the properties that touch the disk.
const FS_ITERS = Math.min(ITERS, 60);

function tmpRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "archivum-fuzz-"));
  fs.mkdirSync(path.join(root, "outside"));
  return { root: path.join(root, "store"), outside: path.join(root, "outside"), parent: root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

/** every file and directory below `dir`, as relative paths */
const tree = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true }).map(String).sort() : []);
const inside = (parent, child) => {
  const rel = path.relative(parent, child);
  return rel !== "" && rel.split(path.sep)[0] !== ".." && !path.isAbsolute(rel);
};

const ATTACK_NAMES = ["", ".", "..", "...", "../..", "../../etc/passwd", "..\\..\\windows", "/", "\\", "C:\\", "C:", "/etc/passwd", "a/b", "a\\b", "\0", "a\0b", ".\0.", "con", "NUL", "aux.txt", "COM1", "foo.", "foo ", " foo", "-", "--", "---", ".-", "-.", "_", "é", "中文", "😀", "a".repeat(500), `${".".repeat(70)}`, "%2e%2e", "~", "$HOME", "$(rm -rf /)", "`id`", "a;b", "a|b", "..;", "\n", "x\ny", "__proto__", "constructor", "toString", "\u202e", "ａｂ", "default"];

function spaceName(rng) {
  const r = rng.next();
  if (r < 0.3) return rng.pick(ATTACK_NAMES);
  if (r < 0.6) return anyString(rng, 100);
  if (r < 0.8) return rng.pick(ATTACK_NAMES) + anyString(rng, 10) + rng.pick(ATTACK_NAMES);
  return plainText(rng, 8);
}

test("fuzz store: sanitizeSpace output is always a single safe path segment, and the store never leaves its root", () => {
  const t = tmpRoot();
  try {
    property("sanitize-space", (rng) => {
      const raw = spaceName(rng);
      const s = sanitizeSpace(raw);
      assert.match(s, /^[A-Za-z0-9_.-]{1,64}$/, show(raw));
      assert.ok(s !== "." && s !== "..", show(raw));
      assert.equal(sanitizeSpace(s), s, "idempotent");
      const store = new Store(t.root, s);
      for (const d of [store.dir, store.wikiDir, store.transcriptsDir, store.notesFile, store.stateFile, store.historyDir, store.historyLog, store.historyFiles, store.proposalsDir]) {
        assert.ok(inside(path.join(t.root, "spaces"), d), `${show(raw)} -> ${d}`);
      }
      assert.deepEqual(path.relative(t.root, store.dir).split(path.sep), ["spaces", s]);
    });
    // resolveSpace: explicit, env and cwd sources all go through the same sanitising
    property("resolve-space", (rng) => {
      const raw = spaceName(rng);
      for (const s of [resolveSpace({ space: raw, env: {} }), resolveSpace({ env: { ARCHIVUM_SPACE: raw || "x" } }), resolveSpace({ env: {}, cwd: path.join(t.parent, raw.replace(/[\0/\\:*?"<>|]/g, "_") || "x") })]) {
        assert.match(s, /^[A-Za-z0-9_.-]{1,64}$/);
        assert.ok(s !== "." && s !== "..");
      }
    });
    assert.deepEqual(tree(t.parent).filter((p) => p.startsWith("outside")), ["outside"]);
  } finally {
    t.cleanup();
  }
});

test("fuzz store: appendNote/readNotes round-trip arbitrary contents and spaces stay isolated", () => {
  const t = tmpRoot();
  try {
    const written = new Map(); // space -> notes
    property("notes-roundtrip", (rng) => {
      const space = sanitizeSpace(spaceName(rng));
      const store = new Store(t.root, space);
      const content = rng.chance(0.2) ? plainText(rng, 20) : anyString(rng, 200) + rng.pick(["", "\n", "\r\n", "\u2028", "\0", "\ud800"]);
      const metadata = rng.pick([undefined, null, [], "str", 5, { a: 1 }, { nested: { "__proto__": 1, deep: [1, { x: anyString(rng, 10) }] } }]);
      const note = store.appendNote(content, metadata);
      assert.equal(note.content, content);
      assert.equal(typeof note.id, "string");
      assert.ok(!Number.isNaN(Date.parse(note.ts)));
      const list = written.get(space) ?? [];
      list.push(note);
      written.set(space, list);
      const read = store.readNotes();
      assert.equal(read.length, list.length, `space ${show(space)}`);
      assert.deepEqual(read.map((n) => n.id), list.map((n) => n.id));
      assert.deepEqual(read.map((n) => n.content), list.map((n) => n.content), "content must survive byte for byte");
      const last = read.at(-1);
      if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) assert.deepEqual(last.metadata, JSON.parse(JSON.stringify(metadata)));
      else assert.equal(last.metadata, undefined);
      assert.equal({}.polluted, undefined);
      assert.ok(inside(path.join(t.root, "spaces"), store.notesFile));
    }, { iters: FS_ITERS });
    // removing one note leaves every other note of the same space alone
    for (const [space, list] of written) {
      const store = new Store(t.root, space);
      const victim = list[Math.floor(list.length / 2)];
      assert.equal(store.removeNote(victim.id), true);
      assert.equal(store.removeNote(victim.id), false);
      assert.deepEqual(store.readNotes().map((n) => n.id), list.filter((n) => n !== victim).map((n) => n.id));
    }
    // nothing but spaces/ was created in the root, and nothing leaked next to it
    assert.deepEqual([...new Set(tree(t.root).map((p) => p.split(path.sep)[0]))], ["spaces"]);
    assert.deepEqual(tree(t.outside), []);
    assert.deepEqual(fs.readdirSync(t.parent).sort(), ["outside", "store"]);
  } finally {
    t.cleanup();
  }
});

const VALID = (i) => JSON.stringify({ id: `note_ok${i}`, ts: "2026-01-01T00:00:00.000Z", content: `valid ${i}` });

function corruptLine(rng) {
  return rng.pick([
    () => VALID(0).slice(0, rng.int(0, VALID(0).length - 1)),
    () => "}" + anyString(rng, 60).replace(/\n/g, " "),
    () => "\0".repeat(rng.int(1, 40)),
    () => JSON.stringify(rng.pick([null, true, 5, "str", [], [1, 2], {}, { id: 5, content: "x" }, { id: "a" }, { content: "x" }, { id: "a", content: 5 }, { id: null, content: null }, { id: [], content: {} }])),
    () => `{"id":"note_x","content":"${"é".repeat(rng.int(1, 2000))}`, // truncated mid-string
    () => `{"__proto__":{"polluted":"yes"},"id":"note_proto","content":"p","constructor":{"prototype":{"polluted":"yes"}}}`,
    () => "\ufeff" + VALID(1),
    () => "   ",
    () => "x".repeat(rng.int(1000, 20_000)),
    () => "[".repeat(rng.int(1, 20_000)),
  ])();
}

test("fuzz store: corrupt notes.jsonl lines are skipped, valid notes survive in order", () => {
  const t = tmpRoot();
  try {
    property("notes-corrupt", (rng) => {
      const store = new Store(t.root, `c${rng.int(0, 5)}`);
      fs.mkdirSync(store.dir, { recursive: true });
      const expected = [];
      const lines = [];
      for (let i = rng.int(0, 25); i > 0; i--) {
        if (rng.chance(0.5)) {
          lines.push(VALID(lines.length));
          expected.push(`note_ok${lines.length - 1}`);
        } else {
          const bad = corruptLine(rng);
          // a corrupt line must not accidentally be a valid note: "\ufeff"+valid has a BOM, which JSON.parse rejects
          lines.push(bad);
          if (bad.includes("note_proto") && !bad.startsWith("\ufeff")) expected.push("note_proto");
        }
      }
      const eol = rng.pick(["\n", "\r\n"]);
      fs.writeFileSync(store.notesFile, lines.join(eol) + rng.pick(["", eol]));
      const notes = store.readNotes();
      // bad lines whose truncation happens to still be a valid note cannot occur: truncated JSON is never complete
      assert.deepEqual(notes.map((n) => n.id), expected, `file:\n${show(fs.readFileSync(store.notesFile, "utf8").slice(0, 400))}`);
      for (const n of notes) assert.equal(typeof n.content, "string");
      assert.equal({}.polluted, undefined);
      assert.equal(Object.prototype.polluted, undefined);
      // the store keeps working after corruption: a new note is appended and can be read back
      const fresh = store.appendNote("fresh note after corruption");
      assert.deepEqual(store.readNotes().map((n) => n.id).at(-1), fresh.id);
      assert.equal(store.readNotes().length, expected.length + 1);
    }, { iters: FS_ITERS });
  } finally {
    t.cleanup();
  }
});

test("regression: a note appended after a crash-truncated last line (no trailing newline) is not lost", () => {
  const t = tmpRoot();
  try {
    const store = new Store(t.root, "crash");
    fs.mkdirSync(store.dir, { recursive: true });
    fs.writeFileSync(store.notesFile, `${VALID(1)}\n{"id":"note_half","ts":"2026-01-01T00:00:00.000Z","con`);
    const fresh = store.appendNote("written after the crash");
    assert.deepEqual(store.readNotes().map((n) => n.id), ["note_ok1", fresh.id]);
    // and the file keeps one record per line afterwards
    store.appendNote("another");
    assert.equal(store.readNotes().length, 3);
  } finally {
    t.cleanup();
  }
});

// ---------------------------------------------------------------- document paths and ids

function docPath(rng) {
  const segs = ["a", "topic.md", "x-y_z.9", ".", "..", "...", "a..b", ".hidden", "", " ", "é", "a\\b", "..\\x", "a\0b", "con", "__proto__", "constructor", "a:b", "x".repeat(120), "a/b"];
  const r = rng.next();
  if (r < 0.2) return anyString(rng, 60);
  if (r < 0.3) return rng.pick(["/", "", "/.", "/./a", "/a/..", "/../a", "/a/../../b", "/a..b", "/..", "\\a", "/a\\..\\b", "C:/a", "/a/", "//a", `/${"a".repeat(201)}`]);
  return `${rng.chance(0.9) ? "/" : ""}${Array.from({ length: rng.int(1, 5) }, () => rng.pick(segs)).join("/")}`;
}

test("fuzz store: isDocPath agrees with core validatePath, and valid paths map into the wiki directory", () => {
  const t = tmpRoot();
  try {
    const store = new Store(t.root, "docs");
    property("doc-paths", (rng) => {
      const p = docPath(rng);
      let coreOk = true;
      try {
        validatePath(p);
      } catch {
        coreOk = false;
      }
      assert.equal(isDocPath(p), coreOk, `core and cli disagree on ${show(p)}`);
      if (!coreOk) {
        assert.throws(() => assertDocPath(p), UsageError);
        assert.throws(() => store.docFile(p), UsageError);
        assert.throws(() => store.writeDoc(p, "x"), UsageError);
        assert.throws(() => store.readDoc(p), UsageError);
        return;
      }
      const file = store.docFile(p);
      assert.ok(inside(store.wikiDir, file), `${show(p)} -> ${file}`);
      const content = anyString(rng, 80).toWellFormed(); // lone surrogates are not representable in a UTF-8 file
      // a file may not shadow a directory that another random path created earlier; skip those collisions
      try {
        store.writeDoc(p, content, { actor: "user" });
      } catch (e) {
        if (["ENOTDIR", "EISDIR", "EEXIST", "EPERM", "EACCES", "ENOENT"].includes(e.code)) return;
        throw e;
      }
      assert.equal(store.readDoc(p), content);
      assert.equal(store.wikiSnapshot()[p], content);
    }, { iters: FS_ITERS });
    assert.deepEqual(tree(t.outside), []);
    assert.deepEqual(fs.readdirSync(t.parent).sort(), ["outside", "store"]);
    for (const rel of tree(t.root)) assert.ok(rel.startsWith("spaces"), rel);
  } finally {
    t.cleanup();
  }
});

test("fuzz store: transcript/proposal ids and history snapshot names cannot escape their directories", () => {
  const t = tmpRoot();
  try {
    const store = new Store(t.root, "ids");
    fs.mkdirSync(store.historyFiles, { recursive: true });
    fs.writeFileSync(path.join(store.dir, "secret.txt"), "top secret");
    fs.writeFileSync(path.join(t.outside, "secret.txt"), "top secret");
    property("ids", (rng) => {
      const id = rng.pick([anyString(rng, 40), `${rng.pick(["..", ".", "a"])}${rng.pick(["/", "\\", ""])}${rng.pick(["..", "secret.txt", "x"])}`, "..", ".", "", "a".repeat(129), "a b", "x/../y", "con", `../outside/${rng.int(0, 9)}`, "__proto__"]);
      for (const fn of [() => store.transcriptFile(id), () => store.proposalDir(id)]) {
        let r;
        try {
          r = fn();
        } catch (e) {
          assert.ok(e instanceof UsageError, `${e}`);
          assert.equal(isSafeId(id), false);
          continue;
        }
        assert.equal(isSafeId(id), true, show(id));
        assert.ok(inside(store.dir, r), `${show(id)} -> ${r}`);
        assert.equal(path.relative(store.dir, r).split(path.sep).length, 2, `${show(id)} -> ${r}`);
      }
      const snap = store.readSnapshotFile(rng.pick([id, `../${id}`, "../secret.txt", "..\\secret.txt", "../../outside/secret.txt", "a/../../secret.txt", "..", "secret.txt/..", path.join(store.dir, "secret.txt"), t.outside]));
      assert.ok(snap === null || typeof snap === "string");
      assert.notEqual(snap, "top secret", "read a file outside the history snapshot directory");
    }, { iters: FS_ITERS });
  } finally {
    t.cleanup();
  }
});

test("regression: readSnapshotFile answers null for names that are not snapshot files instead of throwing", () => {
  const t = tmpRoot();
  try {
    const store = new Store(t.root, "snap");
    fs.mkdirSync(store.historyFiles, { recursive: true });
    fs.writeFileSync(path.join(store.historyFiles, "1-abcd1234"), "v1");
    assert.equal(store.readSnapshotFile("1-abcd1234"), "v1");
    for (const bad of ["", ".", "..", "a\0b", "a/b", "a\\b", "../x", undefined, null, 5, {}, "x".repeat(300), "missing"]) assert.equal(store.readSnapshotFile(bad), null, show(bad));
  } finally {
    t.cleanup();
  }
});

test("regression: a history entry written after a crash-truncated log line is not lost", () => {
  const t = tmpRoot();
  try {
    const store = new Store(t.root, "hist");
    store.writeDoc("/a.md", "one", { actor: "user" });
    fs.appendFileSync(store.historyLog, '{"ts":"2026-01-01T00:00:00.000Z","path":"/half'); // crash mid-write: no closing, no newline
    store.writeDoc("/b.md", "two", { actor: "user" });
    assert.deepEqual(store.readHistory().map((e) => e.path), ["/a.md", "/b.md"]);
  } finally {
    t.cleanup();
  }
});

test("regression: the CLI and core accept exactly the same dot paths", () => {
  for (const p of ["/.", "/./x.md", "/a/./b.md", "/a/.", "/..", "/a..b.md", "/a/..b", "/a../b", "/x.."]) {
    assert.equal(isDocPath(p), false, p);
    assert.throws(() => validatePath(p), { code: "invalid_path" }, p);
  }
  for (const p of ["/.hidden", "/a.b.c", "/a/.b", "/-", "/_", "/a.md", "/a/b/c.md", "/x."]) {
    assert.equal(isDocPath(p), true, p);
    assert.equal(validatePath(p), p);
  }
});
