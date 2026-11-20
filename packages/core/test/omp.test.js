import assert from "node:assert/strict";
import { test } from "node:test";
import { ompJsonlToEvents } from "../src/index.js";

const j = (o) => JSON.stringify(o);

export const OMP_FIXTURE = [
  j({ type: "title", v: 1, title: "Fix the quillon tests" }),
  j({ type: "session", version: 3, id: "01abc-session", timestamp: "2026-11-14T02:40:56.842Z", cwd: "C:\\Users\\me\\proj" }),
  j({ type: "model_change", id: "m1", model: "x/y" }),
  j({ type: "custom", customType: "date-cwd-reminder", data: { reminder: "ignore me" } }),
  j({ type: "message", timestamp: "2026-11-14T02:41:00.000Z", message: { role: "user", content: [{ type: "text", text: "How do I run the tests?" }, { type: "image", data: "xx" }] } }),
  j({
    type: "message",
    timestamp: "2026-11-14T02:41:05.000Z",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "secret chain of thought", thinkingSignature: "sig" },
        { type: "text", text: "Let me look." },
        { type: "text", text: "Checking the Makefile." },
        { type: "toolCall", id: "call_1", name: "bash", arguments: { command: "make test", i: "run" } },
      ],
    },
  }),
  j({ type: "message", timestamp: "2026-11-14T02:41:09.000Z", message: { role: "toolResult", toolCallId: "call_1", toolName: "bash", content: [{ type: "text", text: "12 passed" }], isError: false } }),
  j({ type: "message", timestamp: "2026-11-14T02:41:10.000Z", message: { role: "toolResult", toolCallId: "call_1", toolName: "bash", content: [{ type: "text", text: "boom" }], isError: true } }),
  "{not json",
  j({ type: "message", message: { role: "assistant", content: "Run make test; it passes." } }),
  j({ type: "model_usage", total: 5 }),
].join("\n");

test("converts omp session lines into events and meta", () => {
  const { events, meta, skipped } = ompJsonlToEvents(OMP_FIXTURE);
  assert.deepEqual(meta, { id: "01abc-session", cwd: "C:\\Users\\me\\proj", startedAt: "2026-11-14T02:40:56.842Z", title: "Fix the quillon tests" });
  assert.deepEqual(
    events.map((e) => [e.role, e.name ?? null, e.content]),
    [
      ["user", null, "How do I run the tests?\n[image]"],
      ["assistant", null, "Let me look.\nChecking the Makefile."],
      ["tool", "bash", 'call: {"command":"make test","i":"run"}'],
      ["tool", "bash", "result: 12 passed"],
      ["tool", "bash", "error: boom"],
      ["assistant", null, "Run make test; it passes."],
    ],
  );
  assert.equal(events[0].ts, "2026-11-14T02:41:00.000Z");
  assert.ok(!events.some((e) => /chain of thought|ignore me/.test(e.content)));
  // the unparsable line, model_change, custom and model_usage produced no events; only the broken line and unknown message-less types count
  assert.ok(skipped >= 2);
});

test("caps events (keeps the most recent) and content length", () => {
  const lines = [];
  for (let i = 0; i < 10; i++) lines.push(j({ type: "message", message: { role: "user", content: [{ type: "text", text: `q${i}` }] } }));
  const { events } = ompJsonlToEvents(lines.join("\n"), { maxEvents: 3 });
  assert.deepEqual(events.map((e) => e.content), ["q7", "q8", "q9"]);
  const long = j({ type: "message", message: { role: "user", content: "x".repeat(100) } });
  assert.equal(ompJsonlToEvents(long, { maxContentChars: 10 }).events[0].content.length, 10);
});

test("empty or non-omp input yields no events", () => {
  assert.deepEqual(ompJsonlToEvents("").events, []);
  assert.deepEqual(ompJsonlToEvents('{"type":"session"}\n').events, []);
});

test("tool output is clipped with a marker, prose is not", () => {
  const big = "y".repeat(10_000);
  const text = [
    j({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "c", name: "read", arguments: { path: "/a" } }] } }),
    j({ type: "message", message: { role: "toolResult", toolCallId: "c", toolName: "read", content: [{ type: "text", text: big }] } }),
    j({ type: "message", message: { role: "user", content: [{ type: "text", text: big }] } }),
  ].join("\n");
  const { events } = ompJsonlToEvents(text);
  const tool = events.find((e) => e.role === "tool" && e.content.startsWith("result:"));
  assert.ok(tool.content.length < 4_100, `tool content was ${tool.content.length}`);
  assert.match(tool.content, /\[clipped \d+ more characters\]$/);
  assert.equal(events.find((e) => e.role === "user").content.length, 10_000);
});
