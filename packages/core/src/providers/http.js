// Shared plumbing of the provider adapters: error types, usage accounting and
// a POST-JSON helper with retries (bounded, honours retry-after, abortable).

import { scrubSecrets } from "../scrub.js";

export class LlmError extends Error {
  constructor(message, { status = 0, type = "error", retryable = false, requestId = null } = {}) {
    super(message);
    this.name = "LlmError";
    this.status = status;
    this.type = type;
    this.retryable = retryable;
    this.requestId = requestId;
  }
  /** Authentication, permission or unknown-model/endpoint errors: no agent can succeed. */
  get fatal() {
    return this.status === 401 || this.status === 403 || this.status === 404;
  }
}

export class BudgetExhaustedError extends Error {
  constructor() {
    super("Token budget exhausted.");
    this.name = "BudgetExhaustedError";
  }
}

export class AbortedError extends Error {
  constructor() {
    super("Canceled.");
    this.name = "AbortError";
  }
}

export function zeroUsage() {
  return { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, total_tokens: 0 };
}

const count = (v) => (Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);

export function normalizeUsage(u) {
  const input_tokens = count(u?.input_tokens);
  const output_tokens = count(u?.output_tokens);
  const cache_creation_input_tokens = count(u?.cache_creation_input_tokens);
  const cache_read_input_tokens = count(u?.cache_read_input_tokens);
  return {
    input_tokens,
    output_tokens,
    cache_creation_input_tokens,
    cache_read_input_tokens,
    total_tokens: input_tokens + output_tokens + cache_creation_input_tokens + cache_read_input_tokens,
  };
}

const RETRYABLE_STATUS = new Set([408, 409, 429, 500, 502, 503, 504, 529]);

function parseRetryAfter(value) {
  if (value == null || value === "") return null;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : Math.max(0, at - Date.now());
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new AbortedError());
    const onAbort = () => {
      clearTimeout(timer);
      reject(new AbortedError());
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Aborts when `signal` aborts or after `ms`; `done()` releases the listeners. */
function withTimeout(signal, ms) {
  const ctl = new AbortController();
  const onAbort = () => ctl.abort();
  signal.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => ctl.abort(), ms);
  return {
    signal: ctl.signal,
    done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    },
  };
}

/** Removes the API key (and anything key-shaped) from text that may reach errors or events. */
export function makeRedactor(apiKey) {
  return (text) => {
    let out = String(text);
    if (apiKey) out = out.split(apiKey).join("[REDACTED:api_key]");
    return scrubSecrets(out).text;
  };
}

/**
 * POSTs JSON and returns the parsed body, retrying transient failures.
 * @param {object} o
 * @param {string} o.url
 * @param {Record<string,string>} o.headers
 * @param {object} o.body
 * @param {string} o.label provider name used in messages ("Anthropic" ...)
 * @param {(json:any, text:string)=>{type:string, message:string}} o.describeError
 * @param {(json:any)=>boolean} o.isBadBody true when a 2xx body is not a valid completion
 * @param {typeof fetch} o.fetchImpl
 * @param {AbortSignal} o.signal
 * @param {(t:string)=>string} o.redact
 * @param {{maxAttempts?:number, baseMs?:number, maxMs?:number, maxRetryAfterMs?:number, requestTimeoutMs?:number}} [o.retry]
 */
export async function postJson({ url, headers, body, label, describeError, isBadBody, fetchImpl, signal, redact, retry = {} }) {
  const maxAttempts = retry.maxAttempts ?? 5;
  const baseMs = retry.baseMs ?? 1000;
  const maxMs = retry.maxMs ?? 30_000;
  const maxRetryAfterMs = retry.maxRetryAfterMs ?? 60_000;
  const requestTimeoutMs = retry.requestTimeoutMs ?? 300_000;
  const payload = JSON.stringify(body);

  async function attemptOnce() {
    const t = withTimeout(signal, requestTimeoutMs);
    let res;
    let text;
    try {
      res = await fetchImpl(url, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: payload, signal: t.signal });
      text = await res.text();
    } catch (e) {
      if (signal.aborted) throw new AbortedError();
      throw new LlmError(redact(`Could not reach the ${label} API: ${e?.cause?.message ?? e?.message ?? e}`), { type: "network_error", retryable: true });
    } finally {
      t.done();
    }

    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    const requestId = res.headers?.get?.("request-id") ?? res.headers?.get?.("x-request-id") ?? null;

    if (res.ok) {
      if (!json || typeof json !== "object" || isBadBody(json)) {
        throw new LlmError(`The ${label} API returned an unreadable response.`, { status: res.status, type: "bad_response", retryable: true, requestId });
      }
      return json;
    }
    const { type, message } = describeError(json, text);
    const hint = res.status === 401 ? " Check the API key." : "";
    const err = new LlmError(redact(`${label} API error ${res.status} (${type}): ${message}${hint}`), {
      status: res.status,
      type,
      retryable: RETRYABLE_STATUS.has(res.status) || type === "overloaded_error",
      requestId,
    });
    err.retryAfterMs = parseRetryAfter(res.headers?.get?.("retry-after"));
    throw err;
  }

  if (signal.aborted) throw new AbortedError();
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await attemptOnce();
    } catch (e) {
      if (!(e instanceof LlmError) || !e.retryable) throw e;
      lastErr = e;
      if (attempt === maxAttempts) break;
      const backoff = Math.min(maxMs, baseMs * 2 ** (attempt - 1)) * (0.5 + Math.random() * 0.5);
      await sleep(e.retryAfterMs != null ? Math.min(e.retryAfterMs, maxRetryAfterMs) : backoff, signal);
    }
  }
  lastErr.message = `${lastErr.message} (gave up after ${maxAttempts} attempts)`;
  throw lastErr;
}
