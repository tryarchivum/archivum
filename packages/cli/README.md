<p align="center">
  <img src="https://raw.githubusercontent.com/tryarchivum/archivum/main/docs/assets/logo-light.svg" alt="Archivum" width="64">
</p>

# archivums

**Long-term memory for AI agents. Plain files on your machine, and you review every change.**

The npm package is **`archivums`**; the command it installs is **`archivum`**.

```sh
npx archivums init
```

Archivum keeps what your agent learns as short notes, session transcripts and a small markdown wiki in `~/.archivum`. A background pass called a **dream** reviews them, corrects stale facts and proposes better pages. Nothing changes until you approve the diff. No account, no server, no embeddings: search is BM25 over notes and wiki.

[Website](https://tryarchivum.com) · [Try it in the browser](https://tryarchivum.com/try/) · [Docs](https://tryarchivum.com/docs/) · [GitHub](https://github.com/tryarchivum/archivum) · [X](https://x.com/Use_Archivum)

## Install

Requires Node 22+. One package, zero dependencies (the core library is inside it).

```sh
npx archivums init
```

`init` finds Claude Code, Codex, Hermes, Cursor and Claude Desktop on your machine and sets each one up (the MCP server, plus hooks for Claude Code). Any other MCP client: run `npx -y archivums mcp` as a stdio server. Add `--dry-run` to preview; files it edits are backed up first.

MCP server only, any client:

```sh
claude mcp add archivum -- npx -y archivums mcp
codex mcp add archivum -- npx -y archivums mcp
```

Optional, Claude Code: look memory up before every prompt (nothing is added when nothing matches).

```sh
npm install -g archivums
archivum init --claude-code --prompt-recall
```

This needs `archivum` on your PATH, because it runs before every prompt and `npx` is too slow for that (2.7 to 4.4 s per call measured, against 0.2 to 0.4 s installed).

## What you get

| Piece | Command | Who uses it |
| --- | --- | --- |
| CLI | `archivum remember`, `recall`, `status`, `dream`, `apply`, ... | you |
| MCP server | `archivum mcp`: 17 tools and a context resource | your agent |
| Claude Code hooks | `archivum hook session-start\|user-prompt\|stop` | Claude Code |

## Dreaming

A dream writes a **proposal**, never the live wiki. Review it with `archivum diff`, then `archivum apply` or `archivum reject`. Every applied write is a version you can `archivum restore`.

**Two paths, and the second needs no API key.** Either `archivum dream` with your own LLM key (below), or through the agent you already use: ask it to run a dream and it calls the `dream_prepare` and `dream_submit` tools, using its own model and your existing plan.

### Dreaming with your own key

Only for `archivum dream`. Through your agent none of this is needed.

| Variable | Meaning |
| --- | --- |
| `ARCHIVUM_LLM_PROVIDER` | `anthropic` (default) or `openai` (any OpenAI-compatible `/chat/completions` endpoint with tool calling, for example a local router) |
| `ARCHIVUM_LLM_API_KEY` | falls back to `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` |
| `ARCHIVUM_LLM_BASE_URL` | openai default `http://localhost:20128/v1` |
| `ARCHIVUM_ANALYZER_MODEL`, `ARCHIVUM_ORGANIZER_MODEL` | default `claude-haiku-5-5` for anthropic; required for openai |

It prints a token estimate and asks before spending; the default budget is 3,000,000 tokens and a dream that would exceed it is refused. Dream agents get document tools only (no shell, no network) and treat transcripts as untrusted data. Quality depends on the model you use.

## Commands

| Command | What it does |
| --- | --- |
| `init [--claude-code] [--codex] [--hermes] [--cursor] [--claude-desktop] [--all] [--dry-run] [--home D] [--dir D] [--no-agents-md] [--prompt-recall]` | With no flag it sets up every client it finds on the machine: Claude Code, Codex, Hermes, Cursor and Claude Desktop (`--all` forces all five). Hermes: runs `hermes mcp add` and answers its confirmation. For Claude Code, Codex and Hermes the server is registered as the installed `archivum mcp` when `archivum` is on PATH (it starts in about 0.3 s; `npx -y archivums` took 2.8 to 3.7 s per start when measured, and a client that waits at the first message can time out), and as `npx -y archivums mcp` otherwise. Cursor and Claude Desktop always get the npx form, because GUI apps may not inherit your shell PATH. Cursor and Claude Desktop: adds `mcpServers.archivum` to their JSON config (other servers and keys untouched, backup `*.archivum-bak`, a file it cannot parse is left alone). One client failing never stops the others. For Claude Code it merges the `SessionStart` and `Stop` hooks into `~/.claude/settings.json` (backup `settings.json.archivum-bak`, your own hooks are kept, safe to run twice) and runs `claude mcp add` / `codex mcp add` (prints the command when the binary is missing). `--codex` also adds a short marked block to the project's `AGENTS.md` (backup first; refuses the home folder; `--no-agents-md` skips it): in testing Codex used Archivum only once its project instructions said so. `--prompt-recall` adds the `UserPromptSubmit` hook and needs `archivum` on PATH. |
| `mcp` | MCP server on stdio, 17 tools: `remember`, `update_note`, `recall` (filters `kind`, `since`), `forget`, `context`, `read_document`, `search_documents`, `list_documents`, `related_documents`, `document_history`, `list_notes`, `memory_status`, `save_transcript`, `list_proposals`, `show_proposal`, `dream_prepare`, `dream_submit`; resource `archivum://context`. Near-duplicate notes are flagged, identical ones refused. Memory text is returned as data, never as instructions. |
| `hook session-start\|user-prompt\|stop` | Claude Code hooks (JSON on stdin). Start injects the context digest; `user-prompt` adds the notes that match the prompt and stays silent when nothing matches; stop stores the session transcript. Always exits 0, so a hook can never block a prompt. |
| `log [--file F \| -] [--source S] [--id ID]` | Store a transcript (`{"events":[{role,content}]}` or an array) from any other agent. |
| `import omp [--dir D] [--session FILE] [--all] [--since DATE]` | Store omp sessions as transcripts. |
| `remember "text"`, `recall "query" [--limit N] [--kind note\|wiki] [--since DATE]`, `context [--max-chars N]`, `status` | Notes, search, digest, counts. |
| `dream [--budget TOKENS] [--instructions "..."] [--yes] [--dry-run] [--apply] [--since DATE] [--max-inputs N]` | Analyzes pending transcripts and notes against a staged copy of the wiki. Prints the estimate and asks `Proceed? [y/N]` (or needs `--yes`). Writes a proposal; nothing touches the live wiki until you apply it (`--apply` applies only clean, non-partial runs). `--since` keeps transcripts updated at or after a date; `--max-inputs` caps how many (1 to 200, default 50). |
| `dream --if-due [--min-pending N=3] [--idle-minutes M=10] [--cooldown-hours H=6]` | For cron or Task Scheduler: does nothing (prints `not due: <reason>`, exit 0) unless enough transcripts are pending, the newest is old enough and the last proposal is past the cooldown. When due it is a normal dream. |
| `doctor [--json]` | Read-only health check: Node version, home folder writable, space files parse, Claude Code hooks, `claude` / `codex mcp list` (if on PATH), LLM config (the key is shown only as set or missing), pending work. Exit 0 unless a check fails. |
| `proposals`, `diff [id]`, `apply [id] [--only PATHS] [--force]`, `reject [id]` | Review. `apply` writes a path only if the live file still equals what the dream started from; others are skipped and listed (`--force` overrides). `--only /a.md,/b.md` applies just those pages; the rest stays under review, and `reject` then discards only what is left. |
| `restore <path> [--version N]`, `history [path]` | Every live write is a version. Restore any of them. |
| `retention [--days 30]` | Deletes transcripts dreamed more than N days ago (also done after `dream` and `apply`). |

Exit codes: `0` ok, `1` runtime error, `2` usage or configuration error.

### Scheduled dreams

`--if-due` is safe to run often. When it is due it spends your tokens (bounded by `--budget`) and writes a proposal for you to review; it never touches the live wiki unless you also pass `--apply`.

```sh
# Linux or macOS crontab, every 30 minutes, key read from a file only you can read
*/30 * * * * . ~/.archivum-env && archivum dream --if-due --yes --budget 500000 >> ~/.archivum/dream.log 2>&1
```

```powershell
# Windows Task Scheduler (set ARCHIVUM_LLM_API_KEY as a user environment variable first)
schtasks /Create /SC MINUTE /MO 30 /TN "Archivum dream" /TR "archivum dream --if-due --yes --budget 500000"
```

Not tested under a real scheduler yet; the `--if-due` logic itself is covered by tests.

## Where things live

`$ARCHIVUM_HOME` or `~/.archivum`, one folder per *space* (`--space X`, else `$ARCHIVUM_SPACE`, else the current folder's name):

```
spaces/<space>/
  wiki/                  live markdown files (_index.md is the catalog); edit by hand or with git
  transcripts/<id>.json  session logs (pending, then dreamed)
  notes.jsonl            short notes, one per line
  state.json             notes already consolidated
  history/               log.jsonl + files/<n>-<sha8> snapshots of every live write
  proposals/<id>/        proposal.json, wiki/ (staged copy), base.json
```

All writes are atomic. Secrets (API keys, tokens, private keys) are scrubbed before anything is stored; this is pattern-based, so it is not a guarantee.

## Status

Beta. Verified: the CLI and MCP server on Windows, macOS and Linux (Node 22 and 24), the MCP server with the official SDK client, and the hooks and `init` from a clean install of this package. Not verified: the hooks inside a real Claude Code session, most MCP clients, and any claim that it helps on your own project. Details, test results and the full client table: [github.com/tryarchivum/archivum](https://github.com/tryarchivum/archivum#readme).

MIT licence.
