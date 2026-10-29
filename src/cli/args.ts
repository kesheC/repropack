/**
 * A very small argv parser.
 *
 * Hand-rolled on purpose: the tool advertises zero runtime dependencies, and
 * the surface is small enough that a general parser would be more code than the
 * thing it replaces. The parser understands `--flag`, `--flag=value`,
 * `--flag value`, `-f`, `--no-flag`, and `--` to stop parsing.
 */

export interface ParsedArgs {
  readonly positionals: readonly string[];
  readonly flags: Readonly<Record<string, string | string[] | boolean>>;
  readonly unknown: readonly string[];
}

export interface FlagSpec {
  readonly name: string;
  readonly type: "string" | "number" | "boolean";
  readonly aliases?: readonly string[];
  /** Setting the flag more than once accumulates into an array. */
  readonly repeatable?: boolean;
}

export function parseArgs(argv: readonly string[], specs: readonly FlagSpec[]): ParsedArgs {
  const byName = new Map<string, FlagSpec>();
  for (const spec of specs) {
    byName.set(spec.name, spec);
    for (const alias of spec.aliases ?? []) byName.set(alias, spec);
  }

  const positionals: string[] = [];
  const unknown: string[] = [];
  const flags: Record<string, string | string[] | boolean> = {};

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (!arg.startsWith("-") || arg === "-") {
      positionals.push(arg);
      continue;
    }

    // Strip the dashes before lookup: the spec table is keyed by canonical
    // name ("out"), never by the spelling on the command line ("--out").
    const body = arg.replace(/^--?/, "");
    const eq = body.indexOf("=");
    const rawName = eq >= 0 ? body.slice(0, eq) : body;
    const inlineValue = eq >= 0 ? body.slice(eq + 1) : undefined;
    const direct = byName.get(rawName);
    // "--no-git" may mean a spec literally named "no-git" (flagged true) or
    // the negation of a boolean spec named "git" (flagged false). The former
    // wins so callers can expose a positive --no-x switch.
    const spec = direct ?? (rawName.startsWith("no-") ? byName.get(rawName.slice(3)) : undefined);
    const negated = direct === undefined && spec !== undefined;

    if (!spec) {
      unknown.push(arg);
      continue;
    }
    if (negated) {
      flags[spec.name] = false;
      continue;
    }
    if (spec.type === "boolean") {
      flags[spec.name] = inlineValue === undefined ? true : inlineValue !== "false";
      continue;
    }
    let value = inlineValue;
    if (value === undefined) {
      const next = argv[i + 1];
      if (next === undefined || (next.startsWith("-") && next !== "-")) {
        unknown.push(arg);
        continue;
      }
      value = next;
      i += 1;
    }
    if (spec.repeatable) {
      const existing = flags[spec.name];
      const list = Array.isArray(existing) ? existing : typeof existing === "string" ? [existing] : [];
      flags[spec.name] = [...list, value];
    } else {
      flags[spec.name] = value;
    }
  }

  return { positionals, flags, unknown };
}

export function flagString(args: ParsedArgs, name: string): string | undefined {
  const value = args.flags[name];
  return typeof value === "string" ? value : undefined;
}

export function flagBool(args: ParsedArgs, name: string): boolean {
  return args.flags[name] === true;
}

export function flagNumber(args: ParsedArgs, name: string): number | undefined {
  const raw = flagString(args, name);
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function flagList(args: ParsedArgs, name: string): readonly string[] {
  const value = args.flags[name];
  if (typeof value === "string") return [value];
  return Array.isArray(value) ? value : [];
}