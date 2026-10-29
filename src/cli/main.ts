import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs, flagString, flagBool, flagNumber, flagList, type FlagSpec } from "./args.js";
import { formatBundle, formatVerify } from "./format.js";
import { capture } from "../capture/index.js";
import { replay } from "../replay/index.js";
import { verifyBundle } from "../verify/index.js";
import { readBundle } from "../bundle/read.js";
import { packBundle, ARCHIVE_SUFFIX } from "../archive/index.js";
import { buildReport } from "../report/index.js";
import { createLogger } from "../util/log.js";
import { TOOL_VERSION } from "../version.js";
import type { CaptureScope, VerifyResult } from "../types.js";

const USAGE = `repropack — pack a failing run into something another machine can replay

Usage:
  repropack capture [options] -- <command> [args...]
  repropack replay  [options] <bundle-dir>
  repropack verify  [options] <bundle-dir>
  repropack inspect [options] <bundle-dir>
  repropack pack    [options] <bundle-dir>
  repropack report  [options] <bundle-dir>
  repropack --help | --version

Capture options:
  -o, --out <dir>          bundle output directory (default: ./repropack-bundle)
      --scope <mode>       changed | tracked | all   (default: changed)
  -i, --include <glob>     force-include matching files (repeatable)
  -x, --exclude <glob>     keep matching files out (repeatable)
      --max-file-bytes <n> skip files larger than n bytes (default: 262144)
      --max-bundle-bytes <n> stop adding files past n bytes (default: 8388608)
      --env <NAME>         capture this env var too (repeatable)
      --timeout <ms>       kill the command after ms (default: 300000)
      --no-git             do not probe the git repository

Replay options:
      --workdir <dir>      materialise here instead of a temp dir
      --keep               keep the temp workdir after the run
      --ignore-exit-code   only report drift, do not compare exit codes
      --timeout <ms>       kill the replayed command after ms

Pack options:
  -o, --out <file>         archive path (default: <bundle-id>.repropack)

Report options:
      --archive <name>     archive filename to reference in the report
      --tail <n>           log lines to quote (default: 25)
      --no-environment     omit the environment table

Common options:
      --json               machine-readable output on stdout
  -q, --quiet              suppress progress on stderr
  -v, --verbose            extra progress on stderr
  -h, --help               show this help
      --version            print the version
`;

const COMMON: readonly FlagSpec[] = [
  { name: "help", type: "boolean", aliases: ["h"] },
  { name: "version", type: "boolean" },
  { name: "json", type: "boolean" },
  { name: "quiet", type: "boolean", aliases: ["q"] },
  { name: "verbose", type: "boolean", aliases: ["v"] },
];

const CAPTURE: readonly FlagSpec[] = [
  ...COMMON,
  { name: "out", type: "string", aliases: ["o"] },
  { name: "scope", type: "string" },
  { name: "include", type: "string", aliases: ["i"], repeatable: true },
  { name: "exclude", type: "string", aliases: ["x"], repeatable: true },
  { name: "max-file-bytes", type: "number" },
  { name: "max-bundle-bytes", type: "number" },
  { name: "env", type: "string", repeatable: true },
  { name: "timeout", type: "number" },
  { name: "no-git", type: "boolean" },
];

const REPLAY: readonly FlagSpec[] = [
  ...COMMON,
  { name: "workdir", type: "string" },
  { name: "keep", type: "boolean" },
  { name: "ignore-exit-code", type: "boolean" },
  { name: "timeout", type: "number" },
];

const VERIFY: readonly FlagSpec[] = [...COMMON, { name: "strict", type: "boolean" }];

const INSPECT: readonly FlagSpec[] = [...COMMON];

const PACK: readonly FlagSpec[] = [...COMMON, { name: "out", type: "string", aliases: ["o"] }, { name: "mtime", type: "string" }];

const REPORT: readonly FlagSpec[] = [
  ...COMMON,
  { name: "archive", type: "string" },
  { name: "tail", type: "number" },
  { name: "no-environment", type: "boolean" },
];

/**
 * Entry point. Returns the process exit code rather than calling
 * `process.exit`, so the same function is usable from tests and from the
 * library without taking down an embedding process.
 */
export async function main(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv;

  if (command === undefined || command === "--help" || command === "-h" || command === "help") {
    process.stdout.write(USAGE);
    return 0;
  }
  if (command === "--version" || command === "version") {
    // Extra arguments after `version` are ignored on purpose: scripts append
    // flags liberally and a version probe should never fail on them.
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
      process.stderr.write("error: unknown command '" + command + "'\n\n" + USAGE);
      return 2;
  }
}

async function runCapture(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv, CAPTURE);
  if (flagBool(args, "help")) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (flagBool(args, "version")) {
    process.stdout.write(TOOL_VERSION + "\n");
    return 0;
  }
  const log = createLogger({ quiet: flagBool(args, "quiet"), verbose: flagBool(args, "verbose") });

  if (args.positionals.length === 0) {
    process.stderr.write("error: capture needs a command after --\n");
    return 2;
  }
  if (args.unknown.length > 0) {
    log.warn("unknown option(s): " + args.unknown.join(", "));
  }

  const scope = parseScope(flagString(args, "scope"));
  if (scope === null) {
    process.stderr.write("error: --scope must be one of changed, tracked, all\n");
    return 2;
  }

  const out = resolve(flagString(args, "out") ?? "repropack-bundle");
  log.info("running " + args.positionals.join(" "));
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
  if (flagBool(args, "help")) {
    process.stdout.write(USAGE);
    return 0;
  }
  const log = createLogger({ quiet: flagBool(args, "quiet"), verbose: flagBool(args, "verbose") });
  const bundle = args.positionals[0];
  if (!bundle) {
    process.stderr.write("error: replay needs a bundle directory\n");
    return 2;
  }
  if (args.unknown.length > 0) log.warn("unknown option(s): " + args.unknown.join(", "));

  const result = await replay({
    bundle: resolve(bundle),
    workdir: flagString(args, "workdir") ? resolve(flagString(args, "workdir")!) : undefined,
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
  return result.ok ? 0 : 1;
}

async function runVerify(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv, VERIFY);
  if (flagBool(args, "help")) {
    process.stdout.write(USAGE);
    return 0;
  }
  const bundle = args.positionals[0];
  if (!bundle) {
    process.stderr.write("error: verify needs a bundle directory\n");
    return 2;
  }

  const root = resolve(bundle);
  if (!existsSync(root)) {
    process.stderr.write("error: no such bundle: " + root + "\n");
    return 2;
  }

  const result: VerifyResult = await verifyBundle(root, { strict: flagBool(args, "strict") });
  if (flagBool(args, "json")) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } else {
    process.stdout.write(formatVerify(result) + "\n");
    process.stdout.write((result.ok ? "ok" : "not ok") + " (" + result.findings.length + " finding(s))\n");
  }
  return result.ok ? 0 : 1;
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
  if (flagBool(args, "help")) {
    process.stdout.write(USAGE);
    return 0;
  }
  const bundle = args.positionals[0];
  if (!bundle) {
    process.stderr.write("error: inspect needs a bundle directory\n");
    return 2;
  }
  const root = resolveBundlePath(bundle, "inspect");
  if (root === null) return 2;
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
  return loaded.problems.length === 0 ? 0 : 1;
}

async function runPack(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv, PACK);
  if (flagBool(args, "help")) {
    process.stdout.write(USAGE);
    return 0;
  }
  const log = createLogger({ quiet: flagBool(args, "quiet"), verbose: flagBool(args, "verbose") });
  const target = args.positionals[0];
  if (!target) {
    process.stderr.write("error: pack needs a bundle directory\n");
    return 2;
  }
  if (args.unknown.length > 0) log.warn("unknown option(s): " + args.unknown.join(", "));

  const root = resolveBundlePath(target, "pack");
  if (root === null) return 2;
  const loaded = await readBundle(root);
  if (loaded.problems.length > 0) {
    // A bundle that does not verify should not be handed to a stranger. The
    // archive is the thing people publish, so this is the last cheap stop.
    process.stderr.write("error: refusing to pack a bundle that does not verify\n");
    for (const problem of loaded.problems) process.stderr.write("  - " + problem + "\n");
    return 1;
  }

  const out = resolve(flagString(args, "out") ?? loaded.manifest.id.slice(0, 12) + ARCHIVE_SUFFIX);
  const mtimeRaw = flagString(args, "mtime");
  const mtime = mtimeRaw === undefined ? undefined : Number(mtimeRaw);
  if (mtime !== undefined && !Number.isFinite(mtime)) {
    process.stderr.write("error: --mtime must be a number of seconds since the epoch\n");
    return 2;
  }

  const packed = await packBundle({ root, out, mtime });
  if (flagBool(args, "json")) {
    process.stdout.write(JSON.stringify({ out: packed.out, bytes: packed.bytes, entries: packed.entries }, null, 2) + "\n");
  } else {
    log.info("packed " + String(packed.entries) + " file(s) into " + packed.out);
    process.stdout.write(packed.out + "\n");
  }
  return 0;
}

async function runReport(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv, REPORT);
  if (flagBool(args, "help")) {
    process.stdout.write(USAGE);
    return 0;
  }
  const log = createLogger({ quiet: flagBool(args, "quiet"), verbose: flagBool(args, "verbose") });
  const target = args.positionals[0];
  if (!target) {
    process.stderr.write("error: report needs a bundle directory\n");
    return 2;
  }
  if (args.unknown.length > 0) log.warn("unknown option(s): " + args.unknown.join(", "));

  const root = resolve(target);
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
  return loaded.problems.length === 0 ? 0 : 1;
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