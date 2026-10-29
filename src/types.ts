/**
 * The repropack bundle contract.
 *
 * Everything a bundle contains is `bundle.json` plus a `files/` tree. The JSON
 * is canonical: given the same bundle, every consumer (replay, inspect, verify)
 * must agree on what it means. Nothing in this file reads or writes disk.
 *
 * Version 1 layout:
 *
 *   <bundle>/
 *     bundle.json          manifest (this file's `Bundle`)
 *     files/               worktree snapshot, paths relative to the project root
 *     logs/                captured stdout, stderr and the transcript
 *     Dockerfile           generated replay environment
 *     replay.sh/.cmd       one-command replay entry points
 */

/* ------------------------------------------------------------------ */
/* Manifest                                                            */
/* ------------------------------------------------------------------ */

export const BUNDLE_FORMAT_VERSION = 1;

/** How much of the worktree the bundle carries. */
export type CaptureScope =
  /** Only files the command touched plus the command's declared inputs. */
  | "changed"
  /** Every tracked file, honouring .gitignore. */
  | "tracked"
  /** Everything not gitignored, including untracked. */
  | "all";

export interface Bundle {
  readonly formatVersion: typeof BUNDLE_FORMAT_VERSION;
  /** Stable content id (see util/hash.ts). Two identical bundles share it. */
  readonly id: string;
  readonly createdAt: string;
  /** The tool that produced the bundle. */
  readonly producer: Producer;

  /** What was run and how it ended. */
  readonly command: CommandRecord;
  /** Where it ran: OS, runtime, package manager, resource limits. */
  readonly environment: EnvironmentFingerprint;
  /** Repository identity, if the command ran inside one. */
  readonly repository: RepositorySnapshot | null;
  /** Contents the bundle ships (paths are worktree-relative POSIX). */
  readonly files: readonly BundleFile[];
  /** What redaction did, per file and per log. Values are never included. */
  readonly redaction: RedactionReport;
  /** Problems that make the bundle less faithful; empty means "trustworthy". */
  readonly warnings: readonly string[];
  /** sha256 over the canonical manifest payload (see util/hash.ts). */
  readonly integrity: string;
}

export interface Producer {
  readonly name: "repropack";
  readonly version: string;
  readonly node: string;
}

export interface CommandRecord {
  /** The exact argv, already split. Never a shell string. */
  readonly argv: readonly string[];
  /** Working directory relative to the bundle root (always "."). */
  readonly cwd: string;
  readonly startedAt: string;
  readonly durationMs: number;
  /** Process exit code, or null when killed by a signal. */
  readonly exitCode: number | null;
  readonly signal: string | null;
  /** Log files the bundle carries, relative to the bundle root. */
  readonly stdoutPath: string;
  readonly stderrPath: string;
  /** True when stdout or stderr were truncated to fit the size budget. */
  readonly truncated: boolean;
}

export interface EnvironmentFingerprint {
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly release: string;
  readonly node: string;
  readonly nodeAbi: string;
  /** `npm ls -g --depth=0` style manager probe, null when absent. */
  readonly packageManager: PackageManagerFingerprint | null;
  /** Environment variables, already redacted. Only names in `envAllowlist`. */
  readonly env: Readonly<Record<string, string>>;
  /** Timezone and locale, both of which change test output more often than people expect. */
  readonly timezone: string;
  readonly locale: string;
  readonly resources: ResourceLimits | null;
}

export interface PackageManagerFingerprint {
  readonly name: "npm" | "pnpm" | "yarn" | "bun";
  readonly version: string;
  readonly lockfile: string | null;
}

export interface ResourceLimits {
  readonly cpuCount: number;
  readonly totalMemoryMb: number;
  readonly freeMemoryMb: number;
}

export interface RepositorySnapshot {
  readonly vcs: "git";
  readonly root: string;
  readonly commit: string;
  readonly branch: string | null;
  readonly describe: string | null;
  readonly dirty: boolean;
  /** `git status --porcelain` lines, redacted and capped. */
  readonly statusLines: readonly string[];
  /** Remote URLs with any credentials stripped out. */
  readonly remotes: readonly { readonly name: string; readonly url: string }[];
}

export interface BundleFile {
  /** POSIX path relative to the bundle root. */
  readonly path: string;
  /** Bytes actually written into files/. */
  readonly bytes: number;
  readonly sha256: string;
  readonly mode: "100644" | "100755";
  /** Why this file is in the bundle. */
  readonly reason: FileReason;
  /** True when the file was cut at `maxFileBytes`. */
  readonly truncated: boolean;
}

export type FileReason =
  /** The command's declared entry point or its config. */
  | "input"
  /** Referenced by a stack trace in the captured logs. */
  | "stack-frame"
  /** Changed relative to the repository baseline. */
  | "changed"
  /** Pulled in because a config file pointed at it (tsconfig include, etc.). */
  | "config-target";

/* ------------------------------------------------------------------ */
/* Redaction                                                           */
/* ------------------------------------------------------------------ */

/**
 * Replacement policy. `placeholder` style is required for env vars so the
 * replay environment still *has* the variable; `hash` style keeps two
 * occurrences comparable without revealing either.
 */
export type ReplacementStyle = "placeholder" | "hash" | "length";

export interface RedactionReport {
  readonly rulesVersion: string;
  /** Totals across every surface scanned. */
  readonly totalMatches: number;
  readonly byRule: readonly RuleHit[];
  readonly bySurface: readonly SurfaceHit[];
  /** Findings the engine saw but chose not to touch, with a reason. */
  readonly skipped: readonly SkippedFinding[];
}

export interface RuleHit {
  readonly rule: string;
  readonly count: number;
  /** Never the matched text; only the generated placeholder form. */
  readonly example: string;
}

export interface SurfaceHit {
  readonly surface: string;
  readonly count: number;
}

export interface SkippedFinding {
  readonly rule: string;
  readonly count: number;
  readonly reason: string;
}

/* ------------------------------------------------------------------ */
/* Capture / replay options                                            */
/* ------------------------------------------------------------------ */

export interface CaptureOptions {
  /** Out directory for the bundle. */
  readonly out: string;
  readonly scope: CaptureScope;
  /** Extra globs to include regardless of scope. */
  readonly include?: readonly string[];
  /** Globs to keep out of the bundle. */
  readonly exclude?: readonly string[];
  /** Total bundle byte budget for files/. */
  readonly maxBundleBytes?: number;
  /** Per-file cap; larger files are truncated and flagged. */
  readonly maxFileBytes?: number;
  /** Env var names to keep verbatim after redaction. */
  readonly envAllowlist?: readonly string[];
  /** Hard timeout for the captured command. */
  readonly timeoutMs?: number;
  /** Skip git operations entirely (useful outside a repo). */
  readonly noGit?: boolean;
}

export interface ReplayOptions {
  /** Bundle directory, or a packed `.repropack` archive. */
  readonly bundle: string;
  /** Where to materialise the worktree. Defaults to a temp dir. */
  readonly workdir?: string;
  /** Keep the materialised worktree after the run. */
  readonly keep?: boolean;
  /** Ignore the manifest's exit code and only report drift. */
  readonly ignoreExitCode?: boolean;
  readonly timeoutMs?: number;
}

export interface ReplayResult {
  readonly ok: boolean;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly durationMs: number;
  readonly expectedExitCode: number | null;
  /** Why `ok` is false; empty when the replay reproduced the failure faithfully. */
  readonly reasons: readonly ReplayReason[];
  readonly stdout: string;
  readonly stderr: string;
  readonly workdir: string;
}

export type ReplayReason =
  | { readonly kind: "integrity"; readonly detail: string }
  | { readonly kind: "missing-file"; readonly path: string }
  | { readonly kind: "hash-mismatch"; readonly path: string; readonly expected: string; readonly actual: string }
  | { readonly kind: "exit-code"; readonly expected: number | null; readonly actual: number | null }
  | { readonly kind: "timeout"; readonly timeoutMs: number };

/* ------------------------------------------------------------------ */
/* Verification of a bundle before it leaves the machine                */
/* ------------------------------------------------------------------ */

export interface VerifyFinding {
  readonly severity: "blocker" | "warning" | "note";
  readonly code: VerifyCode;
  readonly message: string;
  readonly path?: string;
}

export type VerifyCode =
  | "leak-suspected"
  | "integrity-mismatch"
  | "missing-file"
  | "oversize"
  | "no-reproducible-command"
  | "absolute-path"
  | "user-home-leak";

export interface VerifyResult {
  readonly ok: boolean;
  readonly findings: readonly VerifyFinding[];
}