/**
 * Plain-object schemas shared by core and the CLI.
 *
 * @typedef {{role:"user"|"assistant"|"system"|"tool", content:string, name?:string, ts?:string}} TranscriptEvent
 * @typedef {{id:string, ts:string, content:string, metadata?:object}} Note
 *   `id` is "note_<random>", `ts` an ISO-8601 string.
 * @typedef {{
 *   id:string, source:string, external_id:string|null, namespace?:string,
 *   created_at:string, updated_at:string,
 *   status:"pending"|"dreamed", dreamed_at:string|null,
 *   events:TranscriptEvent[]
 * }} Transcript   `id` is "trn_<random>".
 */

/** `prefix_` + 16 random bytes, base64url (22 chars). */
export function newId(prefix) {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  const token = btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${prefix}_${token}`;
}
