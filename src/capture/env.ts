import { arch, cpus, freemem, platform, release, totalmem } from "node:os";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tryCapture } from "../util/exec.js";
import { redactText } from "../redact/index.js";
import type { EnvironmentFingerprint, PackageManagerFingerprint, ResourceLimits } from "../types.js";

/**
 * Environment variables captured verbatim (after redaction).
 *
 * An allowlist, not a denylist. A denylist is guaranteed to leak: every new
 * tool invents a new secret-ish variable name, and the bundle is written
 * before anyone notices. If a variable is not needed to reproduce the failure,
 * it does not go in.
 */
export const DEFAULT_ENV_ALLOWLIST: readonly string[] = [
  "PATH",
  "HOME",
  "USERPROFILE",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "SHELL",
  "TERM",
  "CI",
  "GITHUB_ACTIONS",
  "NODE_ENV",
  "COMSPEC",
  "SYSTEMROOT",
  "TEMP",
  "TMP",
  "PATHEXT",
];

/**
 * Variables that describe the capture machine, not the failure.
 *
 * They are captured (they explain *why* a command failed: which node was on
 * PATH, which shell ran it) but they must never be replayed verbatim. Exporting
 * a captured `PATH` on another machine either points at directories that do not
 * exist — `node: command not found`, exit 127 — or, worse, silently resolves a
 * different binary than the one the maintainer meant to test.
 *
 * `TEMP`/`HOME` are additionally redacted into unusable placeholders, so
 * replaying them would hand the command a directory that cannot be created.
 */
export const MACHINE_SPECIFIC_ENV: readonly string[] = [
  "PATH",
  "PATHEXT",
  "HOME",
  "USERPROFILE",
  "TEMP",
  "TMP",
  "COMSPEC",
  "SYSTEMROOT",
];

/**
 * Strip machine-specific variables from a captured environment.
 *
 * Callers that *emit* an environment (generated scripts, Dockerfile, replay)
 * go through this; callers that merely display the fingerprint do not.
 */
export function reproducibleEnv(env: Readonly<Record<string, string>>): Record<string, string> {
  const skip = new Set(MACHINE_SPECIFIC_ENV);
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (skip.has(name.toUpperCase())) continue;
    out[name] = value;
  }
  return out;
}

export interface ProbeEnvironmentOptions {
  cwd: string;
  /** Additional variable names to capture. Matched case-insensitively. */
  envAllowlist?: readonly string[];
  /** Source of truth for the values; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
}

export async function probeEnvironment(options: ProbeEnvironmentOptions): Promise<EnvironmentFingerprint> {
  const env = options.env ?? process.env;
  const allow = [...DEFAULT_ENV_ALLOWLIST, ...(options.envAllowlist ?? [])];

  return {
    platform: platform(),
    arch: arch(),
    release: release(),
    node: process.version,
    nodeAbi: process.versions.modules ?? "unknown",
    packageManager: await probePackageManager(options.cwd),
    env: captureEnv(env, allow),
    timezone: timezoneName(),
    locale: localeName(),
    resources: readResources(),
  };
}

/**
 * Copy the allowlisted variables, redacting each value.
 *
 * Values are redacted even when allowlisted: `PATH` on a developer box contains
 * the user's home directory, and `TEMP` usually does too.
 */
export function captureEnv(
  env: Readonly<Record<string, string | undefined>>,
  allowlist: readonly string[],
): Record<string, string> {
  const wanted = allowlist.map((name) => name.toUpperCase());
  const out: Record<string, string> = {};
  for (const key of Object.keys(env).sort()) {
    const upper = key.toUpperCase();
    if (!wanted.includes(upper)) continue;
    const value = env[key];
    if (typeof value !== "string") continue;
    out[upper] = redactText(value, { surface: "env:" + upper }).text;
  }
  return out;
}

const LOCKFILES: readonly { file: string; name: PackageManagerFingerprint["name"] }[] = [
  { file: "package-lock.json", name: "npm" },
  { file: "npm-shrinkwrap.json", name: "npm" },
  { file: "pnpm-lock.yaml", name: "pnpm" },
  { file: "yarn.lock", name: "yarn" },
  { file: "bun.lockb", name: "bun" },
];

/**
 * Detect the package manager from lockfiles rather than from `npm_config_user_agent`:
 * the lockfile is part of the repository and survives the shell that started us.
 */
export async function probePackageManager(cwd: string): Promise<PackageManagerFingerprint | null> {
  for (const candidate of LOCKFILES) {
    if (!existsSync(join(cwd, candidate.file))) continue;
    const version = await tryCapture([candidate.name, "--version"], { cwd, timeoutMs: 10_000 });
    return { name: candidate.name, version: version ?? "unknown", lockfile: candidate.file };
  }
  return null;
}

function timezoneName(): string {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return zone && zone.length > 0 ? zone : "UTC";
  } catch {
    return "UTC";
  }
}

function localeName(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale || "en-US";
  } catch {
    return "en-US";
  }
}

/** Memory is rounded to whole MB so the fingerprint is stable across runs. */
function readResources(): ResourceLimits | null {
  try {
    return {
      cpuCount: cpus().length,
      totalMemoryMb: Math.round(totalmem() / (1024 * 1024)),
      freeMemoryMb: Math.round(freemem() / (1024 * 1024)),
    };
  } catch {
    return null;
  }
}