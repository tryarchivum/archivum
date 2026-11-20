const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

function stringify(v) {
  try {
    return typeof v === "string" ? v : (JSON.stringify(v) ?? "");
  } catch {
    return "";
  }
}

/** Text of a content value: a string, or an array of blocks ({type:"text", text}); other blocks become a marker. */
function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) => {
      if (typeof b === "string") return b;
      if (!isObject(b)) return "";
      if (b.type === "text" && typeof b.text === "string") return b.text;
      if (b.type === "image") return "[image]";
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

/**
 * Converts an omp (oh-my-pi) session file (JSONL) into Archivum transcript events.
 *
 * Shape handled (omp session v3): one JSON object per line. `{type:"session", id, timestamp, cwd}` opens the file,
 * `{type:"title", title}` names it, and `{type:"message", timestamp, message:{role, content, ...}}` carries the
 * conversation: role `user` (text/image blocks), `assistant` (text, thinking and toolCall blocks `{id, name, arguments}`),
 * `toolResult` (`{toolCallId, toolName, content, isError}`). Everything else (model changes, usage, custom entries,
 * credential pins, unknown types) is ignored. Thinking blocks are dropped. toolCall becomes role "tool" (`call: <json>`),
 * toolResult becomes role "tool" (`result: ...` or `error: ...`) named after its call. When more than `maxEvents`
 * remain, the most recent win. Tolerant of unparsable lines.
 *
 * @param {string} jsonlText
 * @param {{maxEvents?:number, maxContentChars?:number}} [opts]
 * @returns {{events:{role:string, content:string, name?:string, ts?:string}[], skipped:number, meta:{id:string|null, cwd:string|null, startedAt:string|null, title:string|null}}}
 */
export function ompJsonlToEvents(jsonlText, { maxEvents = 5000, maxContentChars = 50_000, maxToolChars = 4_000 } = {}) {
  const events = [];
  const toolNames = new Map();
  const meta = { id: null, cwd: null, startedAt: null, title: null };
  let skipped = 0;

  for (const line of String(jsonlText ?? "").split("\n")) {
    if (!line.trim()) continue;
    const before = events.length;
    const handled = convertLine(line);
    if (!handled && events.length === before) skipped++;
  }
  return { events: events.length > maxEvents ? events.slice(events.length - maxEvents) : events, skipped, meta };

  function convertLine(rawLine) {
    let entry;
    try {
      entry = JSON.parse(rawLine);
    } catch {
      return false;
    }
    if (!isObject(entry)) return false;
    if (entry.type === "session") {
      if (typeof entry.id === "string") meta.id = entry.id;
      if (typeof entry.cwd === "string") meta.cwd = entry.cwd;
      if (typeof entry.timestamp === "string") meta.startedAt = entry.timestamp;
      return true;
    }
    if (entry.type === "title") {
      if (typeof entry.title === "string") meta.title = entry.title.trim();
      return true;
    }
    if (entry.type !== "message" || !isObject(entry.message)) return false;
    const message = entry.message;
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

    if (message.role === "user") {
      push("user", textOf(message.content));
      return true;
    }
    if (message.role === "toolResult") {
      const name = typeof message.toolName === "string" && message.toolName ? message.toolName : (toolNames.get(message.toolCallId) ?? "tool");
      const body = textOf(message.content) || stringify(message.content);
      push("tool", `${message.isError === true ? "error" : "result"}: ${body}`, name);
      return true;
    }
    if (message.role === "assistant") {
      if (typeof message.content === "string") {
        push("assistant", message.content);
        return true;
      }
      if (!Array.isArray(message.content)) return true;
      let texts = [];
      const flush = () => {
        if (texts.length) push("assistant", texts.join("\n"));
        texts = [];
      };
      for (const block of message.content) {
        if (!isObject(block)) continue;
        if (block.type === "text" && typeof block.text === "string") {
          texts.push(block.text);
        } else if (block.type === "toolCall") {
          flush();
          const name = typeof block.name === "string" && block.name ? block.name : "tool";
          if (typeof block.id === "string") toolNames.set(block.id, name);
          push("tool", `call: ${stringify(block.arguments)}`, name);
        }
      }
      flush();
      return true;
    }
    return false;
  }
}
