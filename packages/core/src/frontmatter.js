/**
 * Parses a leading `---` frontmatter block of simple `key: value` lines.
 * `metadata` is the free text after `metadata:` (or null); `fields` holds every
 * key/value pair (lower-cased keys). Quotes around a value are removed.
 * @param {string} content
 * @returns {{name:string|null, description:string|null, metadata:string|null, fields:Record<string,string>, body:string, hasFrontmatter:boolean}}
 */
export function parseFrontmatter(content) {
  const text = String(content ?? "").replace(/^\uFEFF/, "");
  const out = { name: null, description: null, metadata: null, fields: {}, body: text, hasFrontmatter: false };
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!m) return out;
  out.hasFrontmatter = true;
  out.body = text.slice(m[0].length);
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*):[ \t]*([\s\S]*)$/.exec(line); // `.` would stop at U+2028/U+2029 and silently drop the field
    if (!kv) continue;
    const key = kv[1].toLowerCase();
    let value = kv[2].trim();
    if (value.length >= 2 && ((value[0] === '"' && value.at(-1) === '"') || (value[0] === "'" && value.at(-1) === "'"))) value = value.slice(1, -1);
    if (!(key in out.fields)) out.fields[key] = value;
  }
  out.name = out.fields.name || null;
  out.description = out.fields.description || null;
  out.metadata = out.fields.metadata || null;
  return out;
}
