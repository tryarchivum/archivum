import { UsageError } from "./errors.js";

/**
 * Hand-written argument parser.
 * spec: { bool: string[], string: string[], alias: {short: long} }
 * Supports --flag, --flag=value, --flag value, -s, `--` and a bare `-` positional.
 */
export function parseArgs(argv, spec = {}) {
  const bool = new Set(spec.bool ?? []);
  const str = new Set(spec.string ?? []);
  const alias = spec.alias ?? {};
  const flags = {};
  const positionals = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (a === "-" || !a.startsWith("-") || /^-\d/.test(a)) {
      positionals.push(a);
      continue;
    }
    let name;
    let inline;
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      name = eq === -1 ? a.slice(2) : a.slice(2, eq);
      inline = eq === -1 ? undefined : a.slice(eq + 1);
    } else {
      name = alias[a.slice(1)];
      if (!name) throw new UsageError(`Unknown option ${a}`);
    }
    if (bool.has(name)) {
      if (inline !== undefined) throw new UsageError(`Option --${name} does not take a value`);
      flags[name] = true;
    } else if (str.has(name)) {
      let v = inline;
      if (v === undefined) {
        v = argv[++i];
        if (v === undefined) throw new UsageError(`Option --${name} needs a value`);
      }
      flags[name] = v;
    } else {
      throw new UsageError(`Unknown option --${name}`);
    }
  }
  return { flags, positionals };
}

export function intFlag(flags, name, { min = 1, max = Number.MAX_SAFE_INTEGER, fallback } = {}) {
  const raw = flags[name];
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(String(raw).trim())) throw new UsageError(`--${name} must be a whole number`);
  const n = Number(raw);
  if (n < min || n > max) throw new UsageError(`--${name} must be between ${min} and ${max}`);
  return n;
}
