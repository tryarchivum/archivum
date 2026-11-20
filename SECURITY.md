# Security

## Reporting a vulnerability

Email **memoryarchivum@gmail.com** with a description and steps to reproduce. Please do not open a public issue for something exploitable. You will get an acknowledgement; there is no bounty. This is a beta project maintained by a small team.

## Threat model (summary)

What we protect: the user's files under `ARCHIVUM_HOME`, their LLM API key, and the integrity of their memory.

| Threat | Mitigation | Residual risk |
|---|---|---|
| Prompt injection through transcripts, notes or wiki text | dream agents have document tools only (no shell, no network); prompts mark inputs as data; model output is scrubbed; changes are reviewed; base-sha rule; history and restore | a model may still follow an injected instruction inside the wiki it writes; review is the backstop. Tested on a small synthetic set only |
| Secrets stored in memory | `scrubSecrets` on transcripts, notes and dream output | pattern-based; unknown secret formats are not caught |
| Path traversal through wiki paths or space names | path regex, `sanitizeSpace`, store rooted checks | covered by tests; fuzz tests exist |
| Malicious MCP client | MCP tools only touch the current space; `forget` only removes notes | a client can read everything in the space by design |
| Hook abuse | hooks only read hook JSON and write under `ARCHIVUM_HOME`; they never fail the session | `transcript_path` is read as given by the host |
| Cost abuse of the website simulation | server-side key, forced model, token and rate caps per IP and globally, same-origin check | caps are in memory and reset on restart and at UTC midnight; a determined attacker with many IPs can still spend the global cap |
| Leaking the proxy key | key only in server env; never in responses or logs (tested) | operator mistakes |
| Supply chain | zero runtime dependencies | build tooling (Vite) is a dev dependency |

## What is not covered

No external security review has been done. The legal pages are drafts. Treat the project as a beta.
