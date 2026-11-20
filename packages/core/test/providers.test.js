import assert from "node:assert/strict";
import { test } from "node:test";
import { MemoryWiki, runDream } from "../src/index.js";
import { KEY, startFake, text, use } from "./_fakes.js";

const tr = (id) => ({ id, source: "claude-code", text: `TRANSCRIPT ${id} source=claude-code events=1\n\nUSER:\nhello` });
const submit = (summary = "done") => [use("submit", { summary })];

async function withFake(kind, handler, fn) {
  const fake = await startFake(kind, handler);
  try {
    return await fn(fake);
  } finally {
    await fake.close();
  }
}

const run = (fake, extra = {}) =>
  runDream({
    llm: fake.llm,
    models: { analyzer: "model-a", organizer: "model-o" },
    docs: new MemoryWiki(),
    transcripts: [tr("trn_a")],
    budgetTokens: 1_000_000,
    concurrency: 1,
    retry: { baseMs: 1, maxMs: 5 },
    ...extra,
  });

test("anthropic: request shape (headers, system block, cache_control breakpoints, tools)", async () => {
  let n = 0;
  await withFake("anthropic", () => (n++ === 0 ? [use("list_docs")] : submit()), async (fake) => {
    const r = await run(fake, { models: { analyzer: "claude-test-a", organizer: "claude-test-o" } });
    assert.equal(r.status, "completed");
    const [a, b] = fake.requests;
    assert.equal(a.method, "POST");
    assert.equal(a.url, "/v1/messages");
    assert.equal(a.headers["x-api-key"], KEY);
    assert.equal(a.headers["anthropic-version"], "2023-06-01");
    assert.equal(a.body.model, "claude-test-a");
    assert.ok(a.body.max_tokens > 0);
    assert.deepEqual(a.body.system, [{ type: "text", text: a.system, cache_control: { type: "ephemeral" } }]);
    for (const t of a.body.tools) assert.equal(t.input_schema.type, "object");
    assert.deepEqual(a.body.messages[0].content.at(-1).cache_control, { type: "ephemeral" });
    // second call: moving breakpoint on the last block of the last message
    assert.deepEqual(b.body.messages.at(-1).content.at(-1).cache_control, { type: "ephemeral" });
    const asst = b.body.messages[1];
    assert.equal(asst.role, "assistant");
    assert.equal(asst.content.find((x) => x.type === "tool_use").name, "list_docs");
    assert.equal(b.body.messages.at(-1).content[0].type, "tool_result");
  });
});

test("anthropic: cache usage fields are summed into total_tokens", async () => {
  await withFake("anthropic", () => ({ content: submit(), usage: { cache_creation_input_tokens: 5, cache_read_input_tokens: 10 } }), async (fake) => {
    const r = await run(fake);
    assert.deepEqual(r.usage, { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 5, cache_read_input_tokens: 10, total_tokens: 165 });
  });
});

test("anthropic: custom anthropicVersion header", async () => {
  await withFake("anthropic", () => submit(), async (fake) => {
    await run(fake, { llm: { ...fake.llm, anthropicVersion: "2099-01-01" } });
    assert.equal(fake.requests[0].headers["anthropic-version"], "2099-01-01");
  });
});

test("openai: request shape, tool_calls history and role:tool results (several tool calls in one turn)", async () => {
  let n = 0;
  await withFake(
    "openai",
    () => {
      n++;
      if (n === 1) return [text("Reading."), use("list_docs", {}, "call_a"), use("read_doc", { path: "/nope.md" }, "call_b"), use("grep_docs", { pattern: "x" }, "call_c")];
      return submit();
    },
    async (fake) => {
      const r = await run(fake);
      assert.equal(r.status, "completed", JSON.stringify(r));
      const [a, b] = fake.requests;
      assert.equal(a.method, "POST");
      assert.equal(a.url, "/v1/chat/completions");
      assert.equal(a.headers.authorization, `Bearer ${KEY}`);
      assert.equal(a.body.model, "model-a");
      assert.equal(a.body.stream, false);
      assert.ok(a.body.max_tokens > 0);
      assert.equal(a.body.messages[0].role, "system");
      assert.equal(a.body.messages[1].role, "user");
      assert.equal(typeof a.body.messages[1].content, "string");
      assert.ok(a.body.tools.every((t) => t.type === "function" && t.function.parameters.type === "object" && t.function.name));
      assert.equal(JSON.stringify(a.body).includes("cache_control"), false);

      const asst = b.body.messages[2];
      assert.equal(asst.role, "assistant");
      assert.equal(asst.content, "Reading.");
      assert.deepEqual(asst.tool_calls.map((c) => [c.id, c.type, c.function.name]), [["call_a", "function", "list_docs"], ["call_b", "function", "read_doc"], ["call_c", "function", "grep_docs"]]);
      assert.deepEqual(JSON.parse(asst.tool_calls[1].function.arguments), { path: "/nope.md" });
      const tools = b.body.messages.slice(3);
      assert.deepEqual(tools.map((m) => [m.role, m.tool_call_id]), [["tool", "call_a"], ["tool", "call_b"], ["tool", "call_c"]]);
      assert.ok(tools[1].content.startsWith("ERROR: "));
      assert.ok(!tools[0].content.startsWith("ERROR: "));
    },
  );
});

test("openai: no apiKey means no Authorization header; trailing slash in baseUrl is fine", async () => {
  await withFake("openai", () => submit(), async (fake) => {
    const r = await run(fake, { llm: { provider: "openai", baseUrl: `${fake.baseUrl}/` } });
    assert.equal(r.status, "completed", JSON.stringify(r));
    assert.equal(fake.requests[0].headers.authorization, undefined);
    assert.equal(fake.requests[0].url, "/v1/chat/completions");
  });
});

test("openai: usage maps cached prompt tokens to cache_read and keeps totals", async () => {
  await withFake("openai", () => ({ content: submit(), usage: { input_tokens: 70, output_tokens: 20, cache_read_input_tokens: 30 } }), async (fake) => {
    const r = await run(fake);
    assert.deepEqual(r.usage, { input_tokens: 70, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 30, total_tokens: 120 });
  });
});

test("openai: invalid tool-call arguments JSON is reported to the model, not executed", async () => {
  let n = 0;
  await withFake(
    "openai",
    () => {
      n++;
      if (n === 1) return [{ ...use("write_doc", {}, "call_bad"), raw_arguments: '{"path": "/a.md", "content": "unterminated' }];
      return submit("recovered");
    },
    async (fake) => {
      const docs = new MemoryWiki();
      const r = await run(fake, { docs });
      assert.equal(r.status, "completed", JSON.stringify(r));
      assert.equal(docs.list().length, 0);
      assert.match(fake.requests[1].results[0].content, /not valid JSON/);
      assert.equal(fake.requests[1].results[0].is_error, true);
    },
  );
});

test("openai: finish_reason length behaves like max_tokens; missing tool-call ids get generated ones", async () => {
  let n = 0;
  await withFake(
    "openai",
    () => {
      n++;
      if (n === 1) return { content: [use("write_doc", { path: "/half.md", content: "incompl" })], stop_reason: "max_tokens" };
      return submit("ok");
    },
    async (fake) => {
      const docs = new MemoryWiki();
      const r = await run(fake, { docs });
      assert.equal(r.status, "completed", JSON.stringify(r));
      assert.equal(docs.has("/half.md"), false);
      assert.match(fake.requests[1].lastUserText, /cut off/);
    },
  );
  // a gateway that omits ids: the engine invents consistent ones
  const http = await import("node:http");
  let second = null;
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw);
      res.setHeader("content-type", "application/json");
      if (body.messages.length === 2) {
        res.end(JSON.stringify({ choices: [{ finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: [{ type: "function", function: { name: "list_docs", arguments: "" } }] } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
      } else {
        second = body.messages;
        res.end(JSON.stringify({ choices: [{ finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: [{ id: "call_done", type: "function", function: { name: "submit", arguments: JSON.stringify({ summary: "done" }) } }] } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
      }
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const r = await runDream({
      llm: { provider: "openai", baseUrl: `http://127.0.0.1:${server.address().port}/v1` },
      models: { analyzer: "m", organizer: "m" },
      docs: new MemoryWiki(),
      transcripts: [tr("trn_a")],
      budgetTokens: 10_000,
    });
    assert.equal(r.status, "completed", JSON.stringify(r));
    const call = second.find((m) => m.tool_calls).tool_calls[0];
    assert.ok(call.id);
    assert.equal(second.find((m) => m.role === "tool").tool_call_id, call.id);
  } finally {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  }
});
