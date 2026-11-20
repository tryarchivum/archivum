const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

function blockText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (typeof b === "string" ? b : isObject(b) && b.type === "text" && typeof b.text === "string" ? b.text : ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function stringify(v) {
  try {
    return typeof v === "string" ? v : JSON.stringify(v) ?? "";
  } catch {
    return "";
  }
}

/**
 * Converts Claude Code transcript JSONL into Archivum transcript events.
 * Tolerant: unparsable lines, lines without message.role user/assistant,
 * sidechain (subagent) and meta lines, thinking blocks and unknown block types
 * are skipped. Consecutive text blocks are joined; tool_use becomes role "tool"
 * (`call: <json>`), tool_result becomes role "tool" (`result: ...`) named after
 * the matching tool_use. When more than `maxEvents` remain, the most recent win.
 *
 * @param {string} jsonlText
 * @param {{maxEvents?:number, maxContentChars?:number}} [opts]
 * @returns {{events:{role:string, content:string, name?:string, ts?:string}[], skipped:number}}
 *   `skipped` = non-empty lines that produced no event.
 */
export function claudeCodeJsonlToEvents(jsonlText, { maxEvents = 5000, maxContentChars = 50_000, maxToolChars = 4_000 } = {}) {
  const events = [];
  const toolNames = new Map();
  let skipped = 0;
  for (const line of String(jsonlText ?? "").split("\n")) {
    if (!line.trim()) continue;
    const before = events.length;
    convertLine(line);
    if (events.length === before) skipped++;
  }
  return { events: events.length > maxEvents ? events.slice(events.length - maxEvents) : events, skipped };

  function convertLine(rawLine) {
    let entry;
    try {
      entry = JSON.parse(rawLine);
    } catch {
      return;
    }
    if (!isObject(entry) || entry.isSidechain === true || entry.isMeta === true) return;
    const message = entry.message;
    if (!isObject(message) || (message.role !== "user" && message.role !== "assistant")) return;
    let ts;
    if (typeof entry.timestamp === "string" && !Number.isNaN(Date.parse(entry.timestamp))) ts = new Date(entry.timestamp).toISOString();
    const push = (role, content, name) => {
      if (typeof content !== "string" || content.trim() === "") return;
      // Tool output (file dumps, logs) dominates real sessions and rarely carries the lesson; clip it so a dream stays affordable.
      const limit = role === "tool" ? Math.min(maxToolChars, maxContentChars) : maxContentChars;
      const cut = content.length > limit ? content.slice(0, limit) : content;
      const ev = { role, content: role === "tool" && cut.length < content.length ? `${cut}\n… [clipped ${content.length - cut.length} more characters]` : cut };
      if (name) ev.name = name.slice(0, 64);
      if (ts) ev.ts = ts;
      events.push(ev);
    };

    if (typeof message.content === "string") return push(message.role, message.content);
    if (!Array.isArray(message.content)) return;
    let texts = [];
    const flush = () => {
      if (texts.length) push(message.role, texts.join("\n"));
      texts = [];
    };
    for (const block of message.content) {
      if (typeof block === "string") {
        texts.push(block);
      } else if (!isObject(block)) {
        continue;
      } else if (block.type === "text" && typeof block.text === "string") {
        texts.push(block.text);
      } else if (block.type === "tool_use") {
        flush();
        const name = typeof block.name === "string" && block.name ? block.name : "tool";
        if (typeof block.id === "string") toolNames.set(block.id, name);
        push("tool", `call: ${stringify(block.input)}`, name);
      } else if (block.type === "tool_result") {
        flush();
        const name = toolNames.get(block.tool_use_id) ?? "tool_result";
        push("tool", `result: ${blockText(block.content) || stringify(block.content)}`, name);
      }
    }
    flush();
  }
}
