# Archivum Phase 2 roadmap (grounded version)

Replaces the earlier draft in this folder. Every item below starts from something observed in real tests or in the code. Nothing here is dated or promised.

## Where we are (verified)
Works end to end in Claude Code: remember, recall across sessions, update in place, secret redaction, transcripts, dream without an API key, review by diff, apply. Install via `npx archivums init` for 5 clients, but only Claude Code, Codex, Hermes and omp were run in the real app. Evals are synthetic. No external users yet.

## Problems seen in real use (the roadmap is built from these)
1. Every client needed an explicit "remember this"; none saved on its own reliably.
2. A dream added a line the user never said, and turned a redacted credential into a wiki fact.
3. `apply` takes the whole proposal; the user cannot accept 2 of 3 pages.
4. Notes carry no source (who said it, which session, which client).
5. The only way to see memory is CLI output or opening files by hand.
6. A space is the folder name: same-name folders collide, renamed folders lose their memory, and one session's transcript landed in the wrong space.
7. Setup breaks in odd ways (MCP registered for one folder only, stale `archivum-cli` hooks, npx start-up timeout); `doctor` can only report.

## Phase 2 items, in order

### 1. Dream quality (smallest, highest value; builds on existing code)
- Per-claim source: notes get optional `source` data (client, session id, user-stated vs agent-written); proposals cite note ids per statement.
- Mark model-inferred lines in the diff instead of mixing them with user-stated facts.
- Do not turn a redacted credential into a wiki fact unless the user approves it.
- Per-page apply and reject (today: all or nothing).
- Done when: on the recorded z123 scenario the diff shows a source per claim, flags the inferred line, and 2 of 3 pages can be applied.

### 2. Memory Vault (largest build)
- `archivum vault`: local page on 127.0.0.1 to browse spaces, notes, wiki, transcripts, proposals and history.
- First version read-and-review: search, open source, see diff, apply or reject per page, restore a version, delete a note. Editing in the page comes after.
- Constraint from our own rules: zero runtime dependencies, so it is plain Node http plus a static page, no framework.
- Done when: a user can answer "what does my agent remember about this project, and where did it come from?" without opening `.archivum` by hand.

### 3. Capture without "remember this" (experiment, not a promise)
- The Stop hook already stores each transcript. Add a lightweight pass that proposes note candidates from the newest transcript; the user accepts or rejects them (in the Vault or CLI).
- No silent auto-save. Reason: it would store speculation.
- Done when: measured on real sessions, with an accept rate recorded. If most suggestions are rejected, we stop.

### 4. Project identity
- Stable project id (for example the git root or a marker file) instead of the folder name, with the folder name kept as a label.
- Rename and move keep their memory; same-name folders stop colliding.
- Global (personal) memory is deferred; decide after this lands.

### 5. Self-repairing install
- `doctor --fix`: detect MCP registered for the wrong scope, stale `archivum-cli` hooks and skills, a missing global command, and repair them with a backup.

## Later, only if real users ask
Export and import of a space (the files already make this easy), a verified compatibility table for Cursor and Claude Desktop, Git-backed shared wiki for teams, optional embeddings, remote MCP for ChatGPT.

## Not planned
Mandatory accounts or cloud, dream auto-apply, a chat UI, token or market features.

## How we will know it works
Recorded scenarios rerun after each item; share of claims with a source; share of dream lines the user edits or rejects; suggested-note accept rate; install success on a clean Windows machine. Targets are set after the first measurement, not before.
