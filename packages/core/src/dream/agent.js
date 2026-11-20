// One agent conversation: call the model, execute ALL tool calls of a turn,
// answer with a single user message of tool_result blocks, until submit/end.
// Provider-neutral: messages use the canonical Anthropic block format.

export class AgentError extends Error {}

const clip = (s, n) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);
const KNOWN_TOOLS = new Set(["list_docs", "read_doc", "grep_docs", "write_doc", "edit_doc", "delete_doc", "rename_doc", "submit"]);

/**
 * @param {object} o
 * @param {{send:Function}} o.client budget-aware wrapper around the provider
 * @param {string} o.agent "analyzer:<id>" | "organizer"
 * @param {(type:string, message:string, extra?:object)=>void} o.emit
 */
export async function runAgent({ client, model, system, toolbox, firstContent, maxTurns, maxTokens, agent, emit }) {
  const messages = [{ role: "user", content: firstContent }];
  let lastText = "";
  let nudges = 0;

  for (let turn = 1; turn <= maxTurns; turn++) {
    const resp = await client.send({ model, maxTokens, system, tools: toolbox.definitions, messages });
    const content = resp.content;
    const text = content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
    if (text) {
      lastText = text;
      emit("agent_text", clip(text.replace(/\s+/g, " "), 400), { agent });
    }

    if (resp.stopReason === "refusal") throw new AgentError("The model declined to continue (refusal).");

    if (resp.stopReason === "max_tokens") {
      // Output was cut off: a trailing tool call may be incomplete, so none are executed.
      const kept = content.filter((b) => b.type !== "tool_use");
      messages.push({ role: "assistant", content: kept.length ? kept : [{ type: "text", text: "(cut off)" }] });
      messages.push({
        role: "user",
        content: [{ type: "text", text: "Your last response hit the output limit and was cut off; no tool call in it was executed. Continue with smaller steps: write fewer or shorter documents per turn." }],
      });
      continue;
    }

    const toolUses = content.filter((b) => b.type === "tool_use");
    if (toolUses.length === 0) {
      // A model that stops without calling submit (or that emits tool calls as plain text through a gateway) did not finish the job.
      nudges++;
      if (nudges > 2) throw new AgentError("The model stopped without calling submit; it may not support tool calls through this endpoint.");
      messages.push({ role: "assistant", content: content.length ? content : [{ type: "text", text: "(no output)" }] });
      messages.push({
        role: "user",
        content: [{ type: "text", text: "You have not called a tool. Work only through the provided tools. If you are finished, call submit with your summary now; otherwise continue with the next tool call." }],
      });
      continue;
    }
    messages.push({ role: "assistant", content });

    const results = new Array(toolUses.length);
    const submits = [];
    let anyError = false;
    const run = (i) => {
      const block = toolUses[i];
      if (block.parse_error) {
        return { isError: true, text: `The arguments of this ${block.name} call were not valid JSON (${block.parse_error}). Call it again with a JSON object that matches the tool schema.` };
      }
      return toolbox.execute(block.name, block.input);
    };
    const report = (i) => {
      const block = toolUses[i];
      if (!KNOWN_TOOLS.has(block.name)) return;
      const input = block.input && typeof block.input === "object" ? block.input : {};
      const path = [input.path, input.from, input.prefix].find((p) => typeof p === "string");
      emit("tool", clip(results[i].text.split("\n")[0], 200), { agent, tool: block.name, ...(path ? { path } : {}), ok: !results[i].isError });
    };
    toolUses.forEach((block, i) => {
      if (block.name === "submit") return submits.push(i);
      results[i] = run(i);
      if (results[i].isError) anyError = true;
      report(i);
    });

    let submission = null;
    for (const i of submits) {
      if (anyError) {
        results[i] = { isError: true, text: "Not accepted: another tool call in this turn failed. Fix it, check the result, then call submit again." };
      } else if (submission) {
        results[i] = { isError: true, text: "Only one submit per turn." };
      } else {
        const r = run(i);
        results[i] = r;
        if (!r.isError) submission = r.submission;
      }
      report(i);
    }
    if (submission) return { summary: submission.summary, submission };

    messages.push({
      role: "user",
      content: toolUses.map((block, i) => ({
        type: "tool_result",
        tool_use_id: block.id,
        content: results[i].text,
        ...(results[i].isError ? { is_error: true } : {}),
      })),
    });
  }
  throw new AgentError(`Reached the limit of ${maxTurns} turns without calling submit.`);
}
