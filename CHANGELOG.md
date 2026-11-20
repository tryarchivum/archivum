# Changelog

All notable changes. Format follows Keep a Changelog; versions follow semver (0.x: minor versions may change behaviour, and the changelog says how).

## [0.2.14] - unreleased

### Added
- **Apply a dream page by page.** `archivum apply [id] --only /a.md,/b.md` writes just those pages. The proposal stays under review with the rest, `diff` marks applied pages `[already applied]`, `proposals` counts only what is left, and the dream's inputs are marked dreamed when the last page is applied. `reject` after a partial apply discards only the remaining pages, keeps the applied ones and marks the inputs dreamed. A path that is not a pending change of the proposal is refused before anything is written. A page whose live file changed since the dream is still skipped unless `--force`. Without `--only`, `apply` behaves as before.

## [0.2.13] - 2026-11-19

### Added
- **Who wrote a note.** A new note records `source` (the client that created it: `{client, version?, via}`) and, when another client edits it, `updated_by` (the editor and the time). `recall` and `list_notes` show both. The server fills the marker from the MCP `initialize` handshake (`clientInfo`), or `cli` for the terminal, and never from tool arguments, so a model cannot forge it. Names are cleaned (control characters, secrets, 64 characters). It is the name a client announces about itself, not a verified identity: a real Hermes session announced the generic name `mcp`. Notes saved before this release have no marker and are unchanged. Not yet seen with real Claude Code and Codex sessions.
- MCP tool annotations: pure reads (`recall`, `context`, `read_document`, `search_documents`, `list_documents`, `memory_status`, `list_notes`, `related_documents`, `document_history`, `list_proposals`, `show_proposal`) carry `readOnlyHint: true`; `forget` carries `destructiveHint: true`. A real Codex session asked for approval on every `recall`; whether a client skips the prompt for read-only tools has not been tested.

## [0.2.12] - unreleased

### Fixed
- **0.2.11 registered a command that does not exist.** Run as `npx archivums init`, npm puts the package's own `node_modules/.bin` first on PATH, so `init` believed `archivum` was installed and registered `archivum mcp` with Claude Code, Codex and Hermes. Once npx exits that command is gone, and the client could not start the server. The same lookup guarded `--prompt-recall`. `init` now ignores package-runner folders (`_npx`, `node_modules/.bin`) when it asks whether the command is installed. Found by re-verifying the published package with a clean PATH; the first check of 0.2.11 had used a PATH that hid the problem. `latest` was moved back to 0.2.10 while this was fixed.
- Tests only: the three new launch-form tests compared command lines exactly, and the Windows `.cmd` test shim writes a trailing space (`echo %*`), so they failed on the Windows runners while the product was correct. The test helper now trims each recorded call. No package change.

## [0.2.11] - 2026-11-18 (do not use)

### Changed
- `init` registers the MCP server with the installed command (`archivum mcp`, or `cmd /c archivum mcp` on Windows) for Claude Code, Codex and Hermes when `archivum` is on PATH, and with `npx -y archivums mcp` otherwise. Measured on Linux: `npx` 2.8 to 3.7 s per start, installed 0.28 to 0.4 s. A client session reported `CONNECT_TIMEOUT` (30 s) on the first message when started through `npx`. Cursor and Claude Desktop keep `npx`, because GUI apps may not inherit the shell PATH. The `cmd /c archivum mcp` form has not been run on a real Windows client.

## [0.2.10] - unreleased

### Added
- `archivum init` now also sets up **Hermes** (`hermes mcp add`, answering its confirmation), **Cursor** (`~/.cursor/mcp.json`) and **Claude Desktop** (`claude_desktop_config.json`, with `cmd /c npx` on Windows). With no flag it sets up every client it finds; `--hermes`, `--cursor`, `--claude-desktop` and `--all` force them. Existing servers and keys in those files are kept, a backup is written once, a file that cannot be parsed is left alone, and one client failing never stops the others. Cursor and Claude Desktop follow their documented formats and have not been run in those apps.

### Changed
- Tests run with a clean environment: variables such as `HERMES_HOME` from the machine running them no longer leak into the sandbox.

## [0.2.9] - 2026-11-18

### Fixed
- `init --codex`: the home-folder guard compared unresolved paths, so on macOS (HOME behind a symlink, `/var` -> `/private/var`) it silently did not fire. It now compares real paths too.
- The README shown on npmjs.com was stale (7 tools, "dreaming needs your key", no `--codex` / `--prompt-recall`). Rewritten.

### Changed
- Package page: description, keywords, homepage, author; README and CONTRIBUTING rewritten for an English-speaking audience; the Indonesian README is gone.
- Tests tie the READMEs, badges, tool counts and package metadata to the code, and no test can write into the repository root any more.

## [0.2.8] - 2026-11-18

### Added
- `archivum init --claude-code --prompt-recall` installs a `UserPromptSubmit` hook (`archivum hook user-prompt`, the installed command, never `npx`: measured 2.7-4.4 s per call through npx against 0.2 s installed, and an older version exits 2 on this sub-command, which blocks the prompt in Claude Code according to its docs). Without `archivum` on PATH the hook is skipped with a one-line instruction (`npm install -g archivum-cli`) and the other hooks are still installed: before each prompt it searches memory and hands the agent up to 3 matching notes or wiki pages (2500 characters at most, labelled as saved data, the user's prompt is never echoed back). It stays silent when memory is empty, the prompt is short or a slash command, memory knows too few of the prompt's words, or the items were already shown in this session. `ARCHIVUM_PROMPT_RECALL=0` switches it off. Motivation, measured in real Claude Code and Codex runs: agents did not call `recall` on their own.
- 16 tests in `packages/cli/test/prompt-hook.test.js` (relevance, silence, injection text, hostile input, 1,000-note speed, init idempotence).

### Changed (name)
- **The npm package is now `archivums`** (the owner's npm account name; `archivum` was refused). The command is still `archivum`: `npx archivums init`, `npm install -g archivums`, `claude mcp add archivum -- npx -y archivums mcp`. Versions up to 0.2.6 stay on npm as `archivum-cli`; hooks that call `npx -y archivum-cli hook ...` keep working and are recognised by `init` and `doctor` (no duplicates), but they will not receive new versions until `init` is run again with the new name after removing the old entries. `archivum-cli` should be deprecated with a pointer once `archivums` is published (needs the owner's approval).

### Changed
- **One npm package.** `archivum-cli` now carries the core library inside (copied from `packages/core/src` by `prepack`, removed again by `postpack`) and no longer depends on `archivum-core`. `archivum-core` is no longer published; 0.2.0 and 0.2.1 remain on npm. Reason: publishing two packages in the right order is how the 0.2.5 fix went out incomplete. Test `single-package.test.js` packs the CLI, installs the tarball alone and checks remember/recall, secret scrubbing and the prompt hook.
- CI packs and installs only `archivum-cli`; the release workflow publishes only `archivum-cli`.

### Tests
- The two core fuzz tests with absolute time budgets ("under 50 ms", "under 1000 ms") failed on a busy shared machine with no bug (112 to 151 ms and 287 ms observed). They now compare a run with a run four times larger (`growthRatio` in `packages/core/test/_fuzz.js`): linear work grows about 4x, quadratic about 16x, machine speed cancels out. Checked that the helper still catches a deliberately quadratic function (x15 to x19) and passes linear ones and the real scrubber (x2.8), and that the suite passes three times under 4 busy CPU loops.

### Site
- Landing: GitHub icon (and an X icon, hidden until the handle is confirmed) next to "Try the simulation"; the install command (`npx archivums init`) in a labelled, copyable row; install tabs Terminal / Claude Code / Codex / Hermes / MCP with the real commands. The guessed X and Telegram links in the footer are gone; the X icon links to x.com/Use_Archivum.

### Fixed
- `archivum hook <unknown>` exited 2; hooks must never fail a session, so it now exits 0 like every other hook error.
- `init --codex` did not refuse to write `AGENTS.md` into the home folder on macOS, because HOME can be reached through a symlink (`/var` -> `/private/var`) and the guard compared unresolved paths. Found by the macOS CI job; it now compares real paths too.
- The landing stats strip said 7 MCP tools and 16 CLI commands; the server has 17 tools and the CLI 18 commands. Fixed, and `site-claims.test.js` now checks those figures (and every "<n> tools" claim in the public pages) against the code.
- The README shown on npmjs.com (`packages/cli/README.md`) was stale: it listed 7 MCP tools, said dreaming needs your own API key, and did not know `--codex`, `--prompt-recall` or the `user-prompt` hook. An agent reading it told a user exactly that. Rewritten, and `npm-readme.test.js` now ties it to the code. The npm page only updates with the next publish.

### Honest limits
- A question with instructions appended ("... Answer in one short sentence. If you do not know, say so.") used to silence the hook, because the added words are unknown to memory. If the whole prompt is silent, each sentence is now tried on its own, but only when it has at least 3 meaningful words and ALL of them are known to memory. Real Hermes run with that long prompt: hook 3/3 correct, hook off 0/3. Measured offline: 12 of 18 questions with appended instructions recalled, 2 of 12 unrelated multi-sentence prompts got a wrong reminder (npm install slow / pull request review), so this fallback trades some noise for recall.
- Keyword matching only: on 4 paraphrased questions it answered 1. On 10 real questions it answered 8; on 20 unrelated or look-alike prompts it injected nothing. Small sample, one project's memory.
- Not yet run inside a real Claude Code session; Codex has hooks of its own that Archivum does not install.

## [0.2.7] - 2026-11-17

### Added
- `archivum init --codex` writes a marked block into the project's `AGENTS.md` (created, or appended after your text with a `.archivum-bak` backup, updated in place on re-run, never in your home folder). Flags `--dir DIR` and `--no-agents-md`. Measured in a real Codex run: without project instructions Codex acknowledged facts but never called Archivum; with the block it listed Archivum as its source and answered correctly.
- The MCP `initialize` reply now carries `instructions` telling the client when to call `recall` and `remember` (and that memory text is data), for clients that show server instructions to the model.
- 10 tests for the AGENTS.md block (merge, idempotence, CRLF, unterminated markers, backups, home-folder refusal) and the server instructions.

## [0.2.6] - 2026-11-17

### Fixed
- 0.2.5 shipped without the npm token fix: the fix lives in `archivum-core`, which was not republished, so `npx archivum-cli@0.2.5` still pulled `archivum-core@0.2.0` and wrote `npm_` tokens unredacted. Found by installing 0.2.5 from the registry (the tarball check had used a local core). `archivum-core` is now 0.2.1 and `archivum-cli` requires `^0.2.1`. Everything else in 0.2.5 is unchanged. If you stored an npm token with 0.2.4 or 0.2.5, revoke it and remove the note.

## [0.2.5] - 2026-11-17

### Added
- MCP tool `save_transcript`: clients without hooks (Codex, Hermes, Cursor) can store the session so a dream can learn from it. Same id replaces the transcript; secrets are redacted; at most 5000 events and 2,000,000 characters. Measured need: after hours of real use over MCP the transcript count stayed at 0.
- MCP tool `update_note`: replace a note's text in place (same id, first timestamp kept in `created_at`) instead of forget plus remember.
- `remember` (CLI and MCP) no longer saves an identical note twice, and reports a very similar older note (word overlap of 80% or more) so it can be updated or forgotten.
- `recall` accepts `kind` (`note` or `wiki`) and `since` (ISO date, notes only), as MCP arguments and as CLI flags `--kind` and `--since`; results now show a note's metadata.
- `memory_status` says whether a dream is worth suggesting yet (about 20 notes or 3 transcripts), because a dream over 10 short notes cost about 57,000 tokens for little gain.
- 15 tests in `packages/cli/test/v025-tools.test.js`, including arguments of the wrong type for every tool and hostile transcript ids.

### Fixed
- Secret scrubbing missed npm access tokens (`npm_` followed by 36 letters and digits): they were written to disk unredacted in notes and transcripts. Found by the heavy stress run on the published 0.2.4. They are now redacted as `[REDACTED:npm_token]`; npm's own environment variables (`npm_config_cache`, `npm_package_name`, ...) are left alone.
- An MCP tool called with `null` as its arguments threw instead of returning an error.

### Changed
- `search_documents` is kept for compatibility and now documents itself as `recall` with `kind=wiki`.

## [0.2.4] - 2026-11-16

### Fixed
- `dream_submit` and `dream_prepare` returned a thrown error instead of a clean message when called with `null` or a non-object argument.
- Delimiter tags inside transcripts and wiki pages are now neutralised in every form (opening and closing, any letter case) before they reach the agent, so data cannot open a fake `<input_data>` block.

### Added
- 10 more tests for the agent dream path (hostile paths, secrets, type confusion, cross-space draft ids, injection through delimiters), a load check (`project/bench-agent-dream.mjs`) and an eval of the agent dream path (`eval/agent-dream.js`).

## [0.2.3] - 2026-11-16

### Added
- Dream without an API key: MCP tools `dream_prepare` and `dream_submit` (15 tools in total). The running agent (Claude Code, Codex, Hermes) reads the pending inputs and writes the wiki pages itself; the result is a normal proposal that the user reviews with `archivum diff` and applies with `archivum apply`. No tool can apply or reject a proposal.
- `dream_submit` redacts secrets, requires `/_index.md` (max 4096 characters), rejects unsafe paths, and warns about dangling `[[links]]`, pages missing from the index and bad frontmatter.
- A wiki above 60,000 characters is sent to the agent as index + catalog instead of in full.

### Verified
- 10 new unit tests (injection text, secret redaction, path traversal, double submit, no-op, apply conflict, large wiki, warnings); suite 383 of 383.
- Hermes: two dream rounds, the second updated existing pages. Claude Code: one dream on three notes produced four pages and a proposal, left unapplied.
- Not verified: Codex, page quality on long real transcripts, whether an agent recalls memory without being told to.

## [0.2.2] - 2026-11-15

- Fixed: `archivum import omp` did not match the working directory on macOS when it is reached through a symlink (`/var` vs `/private/var`); real paths are compared now.
- Fixed: test scripts use globs, because Node 22 does not expand directories for `node --test`.

## [0.2.1] - 2026-11-15

First published release (`archivum-core@0.2.0`, `archivum-cli@0.2.1`). The CLI package is `archivum-cli` (npm refuses the name `archivum` as too similar to `archiver`); the command is still `archivum`.

- Fixed: `init` and `doctor` did not recognise their own hooks after the package rename, so a second `init` added duplicates (`archivum-cli@0.2.0` has this bug and is deprecated).

### Added
- `archivum doctor` (read-only health check, `--json`), `dream --since`, `dream --max-inputs`, `dream --if-due`.
- Six read-only MCP tools (`memory_status`, `list_notes`, `related_documents`, `document_history`, `list_proposals`, `show_proposal`), 13 in total. There is deliberately no tool to start a dream or apply a proposal.
- Eval: `--scenario <name|all>` with scenarios `drift`, `contradiction`, `injection` and `scale`, and QA baselines (no memory, append-only notes + BM25, seed docs, dreamed docs).
- Seeded fuzz tests for the scrubber, both transcript converters, frontmatter and transcript rendering, wiki path validation, BM25 and the CLI store.
- Agent skill (`skills/archivum/SKILL.md`) and Claude Code, Codex and Cursor plugin manifests.
- CI (Windows, macOS, Linux; Node 22 and 24) and a release workflow with npm provenance.

### Fixed
- Scrubber: private-key scanning was quadratic (200 KB of repeated headers took 2.7 s); replaced with a one-pass scanner. `arc_` and `AKIA` tokens longer than the fixed length are now fully redacted.
- Converters: `maxEvents: 0` returned every event.
- Frontmatter: a value containing U+2028 or U+2029 was dropped.
- Wiki paths: core accepted `/a..b.md` and `/./x` that the CLI refuses, so a dream could finish and then fail when saving the proposal. Core now rejects them too (behaviour change).
- Store: a crash-truncated last line glued the next note or history entry onto it, losing both; appends now repair the missing newline.
- Analyzer prompt: unresolved disagreements between sources are written as `CONFLICT: ...`.

### Performance
- `archivum context` (the SessionStart hook path) reads only `_index.md`: 640 ms to 146 ms with 2000 notes and 400 pages on Windows. `archivum status` counts pages without reading them: 590 ms to 155 ms.
- `estimateDream` was recalibrated on real runs (it overestimated about 4x).

## [0.2.0] - 2026-11-15

First local-first release line (`archivum-core@0.2.0`).

### Added
- `archivum-core`: isomorphic library with the dream engine (analyzer per input, then organizer), Anthropic and OpenAI-compatible providers, BM25 search, in-memory wiki, diffs, context digest, secret scrubbing and converters for Claude Code and omp sessions.
- CLI: `init`, `mcp` (resource `archivum://context`), `hook`, `log`, `import omp`, `remember`, `recall`, `context`, `status`, `dream`, `proposals`, `diff`, `apply`, `reject`, `restore`, `history`, `retention`.
- Eval harness for dreaming.

### Changed
- Tool output in imported transcripts is clipped to 4000 characters.
- Agents that stop without calling `submit` are nudged twice, then marked failed (they used to count as success).
- `recall` hides notes that an applied dream already folded into the wiki.
