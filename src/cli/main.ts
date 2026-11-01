import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs, flagString, flagBool, flagNumber, flagList, type FlagSpec, type ParsedArgs } from "./args.js";
import { COMMANDS, SPECS, SYNOPSIS, CAPTURE, REPLAY, VERIFY, INSPECT, PACK, REPORT, type CommandName } from "./specs.js";
import { formatBundle, formatVerify } from "./format.js";
import { capture } from "../capture/index.js";
import { replay } from "../replay/index.js";
import { verifyBundle } from "../verify/index.js";
import { readBundle } from "../bundle/read.js";
import { packBundle, ARCHIVE_SUFFIX } from "../archive/index.js";
import { buildReport } from "../report/index.js";
import { createLogger } from "../util/log.js";
import { redactText } from "../redact/index.js";
import { TOOL_VERSION } from "../version.js";
import type { CaptureScope, VerifyResult } from "../types.js";

const INTRO = "repropack — pack a failing run into something another machine can replay";

/**
 * Exit codes, in one place because they are part of the interface.
 *
 * Before this existed the codes were whatever fell out of each branch: a typo in
 * a path was 2 from inspect and 70 from replay, and 70 also meant a genuine
 * internal crash, so a caller could not tell its own mistake from ours.
 */
export const EXIT_OK = 0;
/** A check ran and found something: blockers, drift, a tampered hash. */
export const EXIT_FINDINGS = 1;
/** Usage or input error: unknown flag, missing argument, no such bundle. */
export const EXIT_USAGE = 2;
/** repropack itself failed. Not a verdict about the bundle. */
export const EXIT_INTERNAL = 70;

/**
 * Render help for one command, or for the tool as a whole.
 *
 * Generated from the flag table rather than typed out beside it. The two copies
 * drifted in the direction that matters: 'verify --strict' worked for months and
 * appeared in no help text at all, so the one flag that turns warnings into
 * failures was undiscoverable.
 */
function renderHelp(command: CommandName | null): string {
  const lines: string[] = [INTRO, ""];
  if (command === null) {
    lines.push("Usage:");
    for (const name of COMMANDS) lines.push("  repropack " + SYNOPSIS[name]);
    lines.push("  repropack --help | --version", "", "Run 'repropack <command> --help' for the options of one command.", "");
    lines.push("Exit codes:", "  0  ok", "  1  a check found something (see the findings)", "  2  usage or input error", "  70 internal error");
    return lines.join("\n") + "\n";
  }

  lines.push("Usage:", "  repropack " + SYNOPSIS[command], "");
  const rows = SPECS[command];
  const common = new Set(SPECS[command].filter((spec) => COMMON_FLAGS.has(spec.name)).map((spec) => spec.name));
  const own = rows.filter((spec) => !common.has(spec.name));
  if (own.length > 0) {
    lines.push("Options:");
    for (const spec of own) lines.push(flagLine(spec));
    lines.push("");
  }
  lines.push("Common options:");
  for (const spec of rows.filter((spec) => common.has(spec.name))) lines.push(flagLine(spec));
  return lines.join("\n") + "\n";
}

const COMMON_FLAGS = new Set(["help", "version", "json", "quiet", "verbose"]);

function flagLine(spec: FlagSpec): string {
  const alias = spec.aliases?.[0];
  const head = (alias === undefined ? "    " : "-" + alias + ", ") + "--" + spec.name;
  const withArg = spec.arg === undefined ? head : head + " " + spec.arg;
  return "  " + withArg.padEnd(30) + " " + (spec.description ?? "");
}

/** Flags whose spelling is one edit away from something real; used in the error. */
function suggestFlag(name: string, specs: readonly FlagSpec[]): string | null {
  // Distance is measured on the bare name. Comparing the spelling from the
  // command line against a spelling that always carries its dashes charged
  // every candidate the same two edits for the prefix, and let a candidate
  // identical to the input win -- which is how "--out" got told it might have
  // meant "--out".
  const bare = name.replace(/^--?/, "");
  let best: string | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const spec of specs) {
    const spellings: [string, string][] = [["--" + spec.name, spec.name]];
    for (const alias of spec.aliases ?? []) spellings.push(["-" + alias, alias]);
    for (const [spelling, candidate] of spellings) {
      // A flag the parser already knows is not a correction for itself.
      if (candidate === bare) continue;
      const distance = editDistance(bare, candidate);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = spelling;
      }
    }
  }
  // Two edits covers a transposition (--scop / --scope) and a doubled letter;
  // beyond that the guess is worse than silence.
  return bestDistance <= 2 ? best : null;
}

function editDistance(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  let previous = Array.from({ length: cols }, (_unused, index) => index);
  for (let i = 1; i < rows; i += 1) {
    const current = [i];
    for (let j = 1; j < cols; j += 1) {
      const substitution = (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1);
      const insertion = (current[j - 1] ?? 0) + 1;
      const deletion = (previous[j] ?? 0) + 1;
      current.push(Math.min(substitution, insertion, deletion));
    }
    previous = current;
  }
  return previous[cols - 1] ?? 0;
}

/**
 * Judge what every command shares before the command runs: unknown options
 * first, then the two flags that are not per-command requests.
 *
 * The order is the whole point. Each run* function used to answer `--help`
 * before looking at the rest of the line, so `capture --bogus --help` printed
 * the help and exited 0: the typo was invisible and a script that mistyped an
 * option read that as success. A help request is not a licence to ignore the
 * other tokens.
 *
 * `--version` sits in the shared table because `repropack --version` needs it,
 * but no subcommand acts on it, and only some of them answered it: `capture
 * --version` printed the version, while `inspect --version` treated it as a
 * bundle directory and complained about the missing path. It is a top-level
 * request.
 */
function sharedOptionError(args: ParsedArgs, command: CommandName): number | null {
  if (rejectUnknown(args, command)) return EXIT_USAGE;
  if (flagBool(args, "version")) {
    process.stderr.write("error: --version is not supported by '" + command + "'; it applies to 'repropack --version' on its own\n");
    return EXIT_USAGE;
  }
  if (flagBool(args, "help")) {
    process.stdout.write(renderHelp(command));
    return EXIT_OK;
  }
  return null;
}

/**
 * Every flag any command knows, for a guess at the top level.
 *
 * COMMON is spread by reference into each command table, so the Set collapses
 * the copies and keeps the spec objects that carry the descriptions.
 */
const ALL_FLAGS: readonly FlagSpec[] = [...new Set(COMMANDS.flatMap((name) => SPECS[name]))];

/** The tokens after `--help` or `--version`, which take none. */
function rejectStrayAfter(verb: string, rest: readonly string[]): number | null {
  const stray = rest[0];
  if (stray === undefined) return null;
  if (stray.startsWith("-")) {
    // 'repropack --help --bogus' used to print the help and exit 0, which is
    // indistinguishable from a clean run to anything wrapping the command.
    const hint = suggestFlag(stray, ALL_FLAGS);
    process.stderr.write("error: unknown option '" + stray + "'" + (hint === null ? "\n" : "; did you mean '" + hint + "'?\n"));
  } else {
    process.stderr.write("error: unexpected argument '" + stray + "' after " + verb + "\n");
  }
  process.stderr.write("hint: run 'repropack --help' for the usage\n");
  return EXIT_USAGE;
}

/**
 * The one place unknown flags are judged.
 *
 * Accepting them with a warning was worse than it looked: an unrecognised flag
 * is not consumed, so its value falls through to the positionals -- 'capture
 * --scop all -- node x' warned and then ran the command 'all'. Failing here
 * means a typo costs one error message instead of a confusing capture.
 */
function rejectUnknown(args: ParsedArgs, command: CommandName): boolean {
  if (args.missingValue.length === 0 && args.unknown.length === 0) return false;
  for (const flag of args.missingValue) {
    process.stderr.write("error: " + flag + " needs a value\n");
  }
  for (const flag of args.unknown) {
    const hint = suggestFlag(flag, SPECS[command]);
    process.stderr.write("error: unknown option '" + flag + "'" + (hint === null ? "\n" : "; did you mean '" + hint + "'?\n"));
  }
  process.stderr.write("hint: run 'repropack " + command + " --help' for the supported options\n");
  return true;
}

/**
 * Entry point. Returns the process exit code rather than calling
 * `process.exit`, so the same function is usable from tests and from the
 * library without taking down an embedding process.
 */
export async function main(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv;

  if (command === undefined) {
    // Printing help and succeeding looks the same as doing what was asked. A
    // caller that forgot the argument should find out.
    process.stderr.write("error: no command given\n\n" + renderHelp(null));
    return EXIT_USAGE;
  }
  if (command === "--help" || command === "-h" || command === "help") {
    const refused = rejectStrayAfter("--help", rest);
    if (refused !== null) return refused;
    process.stdout.write(renderHelp(null));
    return EXIT_OK;
  }
  if (command === "--version" || command === "version") {
    // Nothing may follow. '--version --bogus' used to print the version and
    // exit 0, so an unrecognised word was answered as if it had been read.
    const refused = rejectStrayAfter("--version", rest);
    if (refused !== null) return refused;
    process.stdout.write(TOOL_VERSION + "\n");
    return 0;
  }

  switch (command) {
    case "capture":
      return runCapture(rest);
    case "replay":
      return runReplay(rest);
    case "verify":
      return runVerify(rest);
    case "inspect":
      return runInspect(rest);
    case "pack":
      return runPack(rest);
    case "report":
      return runReport(rest);
    default:
      // '--bogus' is a mistyped option, not a mistyped command: calling it an
      // unknown command sent the reader looking for a subcommand they never
      // meant to type.
      if (command.startsWith("-")) {
        const hint = suggestFlag(command, ALL_FLAGS);
        process.stderr.write("error: unknown option '" + command + "'" + (hint === null ? "\n" : "; did you mean '" + hint + "'?\n"));
        process.stderr.write("hint: run 'repropack --help' for the usage\n");
        return EXIT_USAGE;
      }
      process.stderr.write("error: unknown command '" + command + "'\n\n" + renderHelp(null));
      return EXIT_USAGE;
  }
}

async function runCapture(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv, CAPTURE);
  const refused = sharedOptionError(args, "capture");
  if (refused !== null) return refused;
  const log = createLogger({ quiet: flagBool(args, "quiet"), verbose: flagBool(args, "verbose") });

  if (args.positionals.length === 0) {
    process.stderr.write("error: capture needs a command after --\n");
    return EXIT_USAGE;
  }

  const scope = parseScope(flagString(args, "scope"));
  if (scope === null) {
    process.stderr.write("error: --scope must be one of changed, tracked, all\n");
    return EXIT_USAGE;
  }

  const out = resolve(flagString(args, "out") ?? "repropack-bundle");
  // This line goes to stderr, which in CI is a log that outlives the bundle. It
  // used to print the argv verbatim while the manifest stored a redacted copy, so
  // a token passed as an argument was scrubbed from the artifact and published
  // anyway in the job output. Progress lines are held to the same rule as the
  // thing they describe.
  log.info("running " + redactText(args.positionals.join(" "), { surface: "command" }).text);
  const result = await capture({
    argv: args.positionals,
    out,
    scope,
    include: flagList(args, "include"),
    exclude: flagList(args, "exclude"),
    maxFileBytes: flagNumber(args, "max-file-bytes"),
    maxBundleBytes: flagNumber(args, "max-bundle-bytes"),
    envAllowlist: flagList(args, "env"),
    timeoutMs: flagNumber(args, "timeout"),
    noGit: flagBool(args, "no-git"),
    toolVersion: TOOL_VERSION,
  });

  if (flagBool(args, "json")) {
    process.stdout.write(JSON.stringify({ out, id: result.bundle.id, warnings: result.bundle.warnings }, null, 2) + "\n");
  } else {
    log.info("bundle written to " + out);
    process.stdout.write(formatBundle(result.bundle) + "\n");
  }
  return 0;
}

async function runReplay(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv, REPLAY);
  const refused = sharedOptionError(args, "replay");
  if (refused !== null) return refused;
  const log = createLogger({ quiet: flagBool(args, "quiet"), verbose: flagBool(args, "verbose") });

  const bundle = args.positionals[0];
  if (!bundle) {
    process.stderr.write("error: replay needs a bundle directory\n");
    return EXIT_USAGE;
  }
  // route the path through the shared guard: a missing directory used to reach
  // replay() as a raw stat/ENOENT and exit 70, the code reserved for repropack
  // itself failing.
  const root = resolveBundlePath(bundle, "replay");
  if (root === null) return EXIT_USAGE;

  const workdir = flagString(args, "workdir");
  const result = await replay({
    bundle: root,
    workdir: workdir === undefined ? undefined : resolve(workdir),
    keep: flagBool(args, "keep"),
    ignoreExitCode: flagBool(args, "ignore-exit-code"),
    timeoutMs: flagNumber(args, "timeout"),
  });

  if (flagBool(args, "json")) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } else {
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    if (result.ok) log.info("replayed faithfully (exit " + String(result.exitCode) + ")");
    else {
      for (const reason of result.reasons) {
        log.error(describeReason(reason));
      }
    }
    if (result.workdir) log.debug("workdir: " + result.workdir);
  }
  return result.ok ? EXIT_OK : EXIT_FINDINGS;
}

async function runVerify(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv, VERIFY);
  const refused = sharedOptionError(args, "verify");
  if (refused !== null) return refused;

  const bundle = args.positionals[0];
  if (!bundle) {
    process.stderr.write("error: verify needs a bundle directory\n");
    return EXIT_USAGE;
  }

  const root = resolveBundlePath(bundle, "verify");
  if (root === null) return EXIT_USAGE;

  const result: VerifyResult = await verifyBundle(root, { strict: flagBool(args, "strict") });
  if (flagBool(args, "json")) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } else {
    process.stdout.write(formatVerify(result) + "\n");
    process.stdout.write((result.ok ? "ok" : "not ok") + " (" + result.findings.length + " finding(s))\n");
  }
  return result.ok ? EXIT_OK : EXIT_FINDINGS;
}

/**
 * Resolve a bundle path the user named, or report the one error message every
 * subcommand shares.
 *
 * Without this, `inspect`/`pack` surface a raw ENOENT from `readBundle` and
 * exit 70 (the "internal error" code), which reads like a repropack bug rather
 * than a typo in the argument.
 */
function resolveBundlePath(target: string, command: string): string | null {
  const root = resolve(target);
  if (!existsSync(root)) {
    process.stderr.write("error: no such bundle: " + root + "\n");
    process.stderr.write("hint: run '" + command + " --help' or check the path\n");
    return null;
  }
  return root;
}

async function runInspect(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv, INSPECT);
  const refused = sharedOptionError(args, "inspect");
  if (refused !== null) return refused;

  const bundle = args.positionals[0];
  if (!bundle) {
    process.stderr.write("error: inspect needs a bundle directory\n");
    return EXIT_USAGE;
  }
  const root = resolveBundlePath(bundle, "inspect");
  if (root === null) return EXIT_USAGE;
  const loaded = await readBundle(root);
  if (flagBool(args, "json")) {
    process.stdout.write(JSON.stringify(loaded.manifest, null, 2) + "\n");
  } else {
    process.stdout.write(formatBundle(loaded.manifest) + "\n");
    if (loaded.problems.length > 0) {
      process.stderr.write("problems:\n");
      for (const problem of loaded.problems) process.stderr.write("  - " + problem + "\n");
    }
  }
  return loaded.problems.length === 0 ? EXIT_OK : EXIT_FINDINGS;
}

async function runPack(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv, PACK);
  const refused = sharedOptionError(args, "pack");
  if (refused !== null) return refused;
  const log = createLogger({ quiet: flagBool(args, "quiet"), verbose: flagBool(args, "verbose") });

  const target = args.positionals[0];
  if (!target) {
    process.stderr.write("error: pack needs a bundle directory\n");
    return EXIT_USAGE;
  }

  const root = resolveBundlePath(target, "pack");
  if (root === null) return EXIT_USAGE;
  const loaded = await readBundle(root);
  if (loaded.problems.length > 0) {
    // A bundle that does not verify should not be handed to a stranger. The
    // archive is the thing people publish, so this is the last cheap stop.
    process.stderr.write("error: refusing to pack a bundle that does not verify\n");
    for (const problem of loaded.problems) process.stderr.write("  - " + problem + "\n");
    return EXIT_FINDINGS;
  }

  // The manifest agreeing with itself is not the same as the bundle being safe
  // to publish. verify is the gate that answers the second question, and until
  // now pack never asked it: a stray .env beside the logs verified clean (verify
  // only reads what the manifest declares) and was compressed into the archive
  // that gets attached to an issue.
  const verdict = await verifyBundle(root);
  const blockers = verdict.findings.filter((finding) => finding.severity === "blocker");
  const allow = flagBool(args, "force");
  if (blockers.length > 0 && !allow) {
    process.stderr.write("error: refusing to pack a bundle that does not verify\n");
    for (const finding of blockers) {
      process.stderr.write("  - " + finding.code + (finding.path === undefined ? "" : " " + finding.path) + ": " + finding.message + "\n");
    }
    process.stderr.write("hint: run 'repropack verify " + target + "' to see every finding\n");
    process.stderr.write("hint: pass --force to pack anyway (the archive is what people publish)\n");
    return EXIT_FINDINGS;
  }
  if (allow) {
    for (const finding of verdict.findings.filter((item) => item.severity !== "note")) {
      log.warn(finding.code + (finding.path === undefined ? "" : " " + finding.path) + ": " + finding.message);
    }
  }

  const out = resolve(flagString(args, "out") ?? loaded.manifest.id.slice(0, 12) + ARCHIVE_SUFFIX);
  const mtimeRaw = flagString(args, "mtime");
  const mtime = mtimeRaw === undefined ? undefined : Number(mtimeRaw);
  if (mtime !== undefined && !Number.isFinite(mtime)) {
    process.stderr.write("error: --mtime must be a number of seconds since the epoch\n");
    return EXIT_USAGE;
  }

  const packed = await packBundle({ root, out, mtime });
  if (flagBool(args, "json")) {
    process.stdout.write(JSON.stringify({ out: packed.out, bytes: packed.bytes, entries: packed.entries }, null, 2) + "\n");
  } else {
    log.info("packed " + String(packed.entries) + " file(s) into " + packed.out);
    process.stdout.write(packed.out + "\n");
  }
  return EXIT_OK;
}

async function runReport(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv, REPORT);
  const refused = sharedOptionError(args, "report");
  if (refused !== null) return refused;
  const log = createLogger({ quiet: flagBool(args, "quiet"), verbose: flagBool(args, "verbose") });

  const target = args.positionals[0];
  if (!target) {
    process.stderr.write("error: report needs a bundle directory\n");
    return EXIT_USAGE;
  }

  const root = resolveBundlePath(target, "report");
  if (root === null) return EXIT_USAGE;
  const loaded = await readBundle(root);
  const report = await buildReport({
    bundle: loaded.manifest,
    root,
    archiveName: flagString(args, "archive"),
    tailLines: flagNumber(args, "tail"),
    includeEnvironment: !flagBool(args, "no-environment"),
  });

  if (flagBool(args, "json")) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  } else {
    // The body already ends with a newline; the title is a separate field so
    // a script can grab it with `repropack report --json | jq -r .title`.
    process.stdout.write(report.body);
  }
  return loaded.problems.length === 0 ? EXIT_OK : EXIT_FINDINGS;
}

function parseScope(raw: string | undefined): CaptureScope | null {
  if (raw === undefined) return "changed";
  if (raw === "changed" || raw === "tracked" || raw === "all") return raw;
  return null;
}

function describeReason(reason: { kind: string } & Record<string, unknown>): string {
  switch (reason.kind) {
    case "integrity":
      return "integrity: " + String(reason.detail);
    case "missing-file":
      return "missing file: " + String(reason.path);
    case "hash-mismatch":
      return "hash mismatch: " + String(reason.path);
    case "exit-code":
      return "exit code drifted: expected " + String(reason.expected) + ", got " + String(reason.actual);
    case "timeout":
      return "timed out after " + String(reason.timeoutMs) + "ms";
    default:
      return reason.kind;
  }
}