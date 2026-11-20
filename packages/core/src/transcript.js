// Labelled plain-text rendering of transcripts and notes: the form in which
// the dream agents receive their input.

const LABEL_LIKE = /^(?:USER:|ASSISTANT:|SYSTEM:|TOOL .*:|TRANSCRIPT\s|NOTES\s)/;

function escapeContent(text) {
  return String(text ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/\n+$/, "")
    .split("\n")
    .map((line) => (LABEL_LIKE.test(line) ? ` ${line}` : line))
    .join("\n");
}

const ROLE_LABEL = { user: "USER", assistant: "ASSISTANT", system: "SYSTEM" };

/**
 * @param {{id:string, source:string, events:{role:string, content:string, name?:string}[]}} t
 */
export function renderTranscript({ id, source, events }) {
  const list = Array.isArray(events) ? events : [];
  const blocks = list.map((e) => {
    const body = escapeContent(e?.content);
    if (e?.role === "tool") {
      const name = String(e.name || "tool").replace(/[\r\n:]+/g, " ").trim() || "tool";
      return `TOOL ${name}:\n${body}`;
    }
    return `${ROLE_LABEL[e?.role] ?? "SYSTEM"}:\n${body}`;
  });
  return [`TRANSCRIPT ${id} source=${source} events=${list.length}`, ...blocks].join("\n\n");
}

/**
 * @param {{id:string, ts:string, content:string}[]} notes
 */
export function renderNotes(notes) {
  const list = Array.isArray(notes) ? notes : [];
  const lines = list.map((n) => `- [${n.ts}] (${n.id}) ${String(n.content ?? "").replace(/\r\n?/g, "\n").replace(/\n+$/, "").replace(/\n/g, "\n  ")}`);
  const header = `NOTES source=notes count=${list.length}`;
  return list.length ? `${header}\n\n${lines.join("\n")}` : header;
}
