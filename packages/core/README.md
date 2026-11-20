# archivum-core

Isomorphic core of [Archivum](../../README.md): local-first memory for agents. Zero dependencies, no `node:` imports (it runs in Node >= 22 and is bundled for the browser).

```js
import { MemoryWiki, buildContext, buildCorpus, searchCorpus, runDream, renderTranscript } from "archivum-core";
```

| Export | What it does |
| --- | --- |
| `MemoryWiki` | In-memory wiki / DocsApi: `list get write delete rename snapshot clone`; errors carry `.code` (`conflict not_found invalid_path too_large quota`). |
| `buildContext(wiki, notes, {maxChars})` | The small text injected at session start: `/_index.md` cut at a line boundary, else newest notes. |
| `buildCorpus` / `searchCorpus` | BM25 (k1 1.5, b 0.75) over notes + wiki, light stemming, title weight x3, deterministic. No embeddings. |
| `diffDocs` / `lineDiff` | Snapshot diff and LCS line diff, for review-before-apply. |
| `scrubSecrets`, `sha256Hex`, `parseFrontmatter`, `newId` | Pure helpers. |
| `renderTranscript` / `renderNotes` | Labelled plain-text form fed to the dream agents (label-like lines are escaped). |
| `claudeCodeJsonlToEvents` | Converts Claude Code transcript JSONL into events. |
| `runDream`, `estimateDream` | The dream: one analyzer per input, then one organizer, against a staging wiki. |

## runDream

```js
const result = await runDream({
  llm: { provider: "anthropic", apiKey },            // or { provider: "openai", apiKey, baseUrl: "http://localhost:20128/v1" }
  models: { analyzer: "claude-haiku-5-5", organizer: "claude-haiku-5-5" },
  docs: staging,                                      // MemoryWiki clone of the live wiki
  transcripts: [{ id, source, text: renderTranscript(t) }],
  budgetTokens: 3_000_000,
  onEvent: (e) => console.log(e.type, e.agent, e.message),
});
```

`provider: "openai"` means any OpenAI-compatible `POST {baseUrl}/chat/completions` endpoint with tool calling (a local router, a gateway, OpenAI itself). `apiKey` is optional there. Internally messages use Anthropic's block format; `providers/anthropic.js` and `providers/openai.js` translate.

Events (all have `type`, `ts`, `message`): `phase`, `analyzer_started|analyzer_done` (`agent:"analyzer:<id>"`, `inputId`), `organizer_started|organizer_done`, `agent_text`, `tool` (`agent`, `tool`, `path?`, `ok`), `usage` (cumulative `usage`), `budget`, `error`.

The agents get document tools only (`list_docs read_doc grep_docs write_doc edit_doc delete_doc rename_doc submit`): no shell, no network. Everything they write passes `scrubSecrets`. Failures never reject the promise and never contain the API key.

## Tests

`node --test "packages/core/test/*.test.js"` (fake Anthropic and fake OpenAI-compatible servers in `test/_fakes.js`).
