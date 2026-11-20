# Contributing

Thanks for looking. The project is small on purpose: Node built-ins only, no runtime dependencies, plain JavaScript with JSDoc.

## Run it

```sh
git clone https://github.com/tryarchivum/archivum && cd archivum
npm install
npm test                                   # about 20 seconds, no network
node packages/cli/bin/archivum.js --help   # the real CLI
```

Node 22 or later. Tests spawn the real binary against fake LLM servers and a temporary `ARCHIVUM_HOME`, so they never touch your own memory.

## Layout

```
packages/core/   internal library (search, wiki, diffs, secret scrubber, the dream engine). Runs in Node and browsers:
                 no `node:` imports, no Node globals. A test checks this.
packages/cli/    the published package `archivums`: CLI, MCP server, Claude Code hooks. `prepack` copies core into it.
eval/            small synthetic evaluation harness for dreaming (`node eval/run.js --baseline` needs no key)
skills/          the agent skill, plus the plugin manifests in .claude-plugin/, .codex-plugin/, .cursor-plugin/
```

## What a change needs

1. **A test.** CLI behaviour with the real binary; MCP changes through `tools/list` and `tools/call`; a claim in a README or manifest is checked by a test too (`packages/cli/test/npm-readme.test.js` is the pattern).
2. **Docs in step.** A new flag or command goes into the usage text in `packages/cli/src/cli.js`, `packages/cli/README.md` and the root `README.md`. A new or removed MCP tool changes the counts there; the tests will tell you where.
3. **Honest claims.** Do not write "works with X" unless you ran it with X.
4. **No secrets.** Keys come from environment variables. Tests use fake servers.
5. **A dream never writes the live wiki.** Only `apply` does, and only for files that still match what the dream started from. Please do not add an automatic path around that.

## Reporting a problem

Bugs and ideas: open an issue. Anything exploitable: see [SECURITY.md](SECURITY.md) and do not open a public issue.
