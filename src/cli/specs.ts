/**
 * The flag table, in one place.
 *
 * Every flag the parser accepts lives here together with the sentence that
 * explains it. Keeping the description next to the spec is what makes the help
 * honest: it used to be a hand-written block in main.ts, and the two drifted --
 * 'verify --strict' was parseable for months without appearing in any help
 * text, while the README told people to run --help for every flag.
 */

import type { FlagSpec } from "./args.js";

export const COMMANDS = ["capture", "replay", "verify", "inspect", "pack", "report"] as const;

export type CommandName = (typeof COMMANDS)[number];

const COMMON: readonly FlagSpec[] = [
  { name: "help", type: "boolean", aliases: ["h"], description: "show this help" },
  { name: "version", type: "boolean", description: "print the version" },
  { name: "json", type: "boolean", description: "machine-readable output on stdout" },
  { name: "quiet", type: "boolean", aliases: ["q"], description: "suppress progress on stderr" },
  { name: "verbose", type: "boolean", aliases: ["v"], description: "extra progress on stderr" },
];

export const CAPTURE: readonly FlagSpec[] = [
  ...COMMON,
  { name: "out", type: "string", aliases: ["o"], arg: "<dir>", description: "bundle output directory (default: ./repropack-bundle)" },
  { name: "scope", type: "string", arg: "<mode>", description: "changed | tracked | all   (default: changed)" },
  { name: "include", type: "string", aliases: ["i"], repeatable: true, arg: "<glob>", description: "force-include matching files (repeatable)" },
  { name: "exclude", type: "string", aliases: ["x"], repeatable: true, arg: "<glob>", description: "keep matching files out (repeatable)" },
  { name: "max-file-bytes", type: "number", arg: "<n>", description: "skip files larger than n bytes (default: 262144)" },
  { name: "max-bundle-bytes", type: "number", arg: "<n>", description: "stop adding files past n bytes (default: 8388608)" },
  { name: "env", type: "string", repeatable: true, arg: "<NAME>", description: "capture this env var too (repeatable)" },
  { name: "timeout", type: "number", arg: "<ms>", description: "kill the command after ms (default: 300000)" },
  { name: "no-git", type: "boolean", description: "do not probe the git repository" },
];

export const REPLAY: readonly FlagSpec[] = [
  ...COMMON,
  { name: "workdir", type: "string", arg: "<dir>", description: "materialise here instead of a temp dir" },
  { name: "keep", type: "boolean", description: "keep the temp workdir after the run" },
  { name: "ignore-exit-code", type: "boolean", description: "report an exit code drift as a note, do not fail on it" },
  { name: "timeout", type: "number", arg: "<ms>", description: "kill the replayed command after ms (default: 300000)" },
];

export const VERIFY: readonly FlagSpec[] = [
  ...COMMON,
  { name: "strict", type: "boolean", description: "fail on warnings as well as blockers" },
];

export const INSPECT: readonly FlagSpec[] = [...COMMON];

export const PACK: readonly FlagSpec[] = [
  ...COMMON,
  { name: "out", type: "string", aliases: ["o"], arg: "<file>", description: "archive path (default: <bundle-id>.repropack)" },
  { name: "mtime", type: "string", arg: "<seconds>", description: "mtime recorded in the archive (default: now)" },
  { name: "force", type: "boolean", description: "pack even when verify reports blockers" },
];

export const REPORT: readonly FlagSpec[] = [
  ...COMMON,
  { name: "archive", type: "string", arg: "<name>", description: "archive filename to reference in the report" },
  { name: "tail", type: "number", arg: "<n>", description: "log lines to quote (default: 25)" },
  { name: "no-environment", type: "boolean", description: "omit the environment table" },
];

export const SPECS: Readonly<Record<CommandName, readonly FlagSpec[]>> = {
  capture: CAPTURE,
  replay: REPLAY,
  verify: VERIFY,
  inspect: INSPECT,
  pack: PACK,
  report: REPORT,
};

/** One-line synopsis per command, used by the help renderer and by errors. */
export const SYNOPSIS: Readonly<Record<CommandName, string>> = {
  capture: "capture [options] -- <command> [args...]",
  replay: "replay  [options] <bundle-dir>",
  verify: "verify  [options] <bundle-dir>",
  inspect: "inspect [options] <bundle-dir>",
  pack: "pack    [options] <bundle-dir>",
  report: "report  [options] <bundle-dir>",
};
