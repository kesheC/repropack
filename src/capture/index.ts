import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { run } from "../util/exec.js";
import { elideMiddle } from "../util/bytes.js";
import { parseStackFrames, isRuntimePath } from "../util/stack.js";
import { redactText, mergeReports, collectEnvLiterals, type RedactionResult } from "../redact/index.js";
import { writeBundle, type StagedFile } from "../bundle/write.js";
import { writeExportArtifacts } from "../export/index.js";
import { probeRepository } from "./git.js";
import { probeEnvironment } from "./env.js";
import { scanWorktree } from "./scan.js";
import type { Bundle, CaptureOptions } from "../types.js";

export interface CaptureInput extends CaptureOptions {
  /** Command and arguments to run; argv[0] must be a real executable. */
  argv: readonly string[];
  /** Extra environment for the child; merged over `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Version string recorded in the manifest. */
  toolVersion: string;
  /** Directory the command runs in; defaults to the process cwd. */
  cwd?: string;
}

export interface CaptureResult {
  bundle: Bundle;
  root: string;
}

const MAX_LOG_BYTES = 2 * 1024 * 1024;

/**
 * Run a command and write a bundle describing the failure.
 *
 * Ordering is the safety property: the command runs, its output is redacted,
 * and only then is anything written to disk. No captured byte reaches the
 * output directory before `redactText` has seen it.
 */
export async function capture(options: CaptureInput): Promise<CaptureResult> {
  const cwd = options.cwd ?? process.cwd();
  const startedAt = new Date().toISOString();
  const timeoutMs = options.timeoutMs ?? 300_000;

  const execution = await run(options.argv, {
    cwd,
    env: options.env ? { ...process.env, ...options.env } : process.env,
    timeoutMs,
    maxLogBytes: MAX_LOG_BYTES,
  });

  const repository = options.noGit ? null : await probeRepository(cwd);
  const environment = await probeEnvironment({ cwd, envAllowlist: options.envAllowlist });

  const warnings: string[] = [];
  const stackPaths = parseStackFrames(execution.stdout + "\n" + execution.stderr)
    .map((frame) => frame.raw)
    .filter((path) => !isRuntimePath(path));

  const scan = await scanWorktree({
    cwd,
    scope: options.scope,
    include: options.include,
    exclude: options.exclude,
    // A bundle written inside the project would otherwise capture itself on
    // the next run: the previous bundle is just another directory on disk.
    outDir: options.out,
    maxFileBytes: options.maxFileBytes,
    maxBundleBytes: options.maxBundleBytes,
    stackFramePaths: stackPaths,
  });
  warnings.push(...scan.warnings);

  const literals = collectEnvLiterals(environment.env, options.envAllowlist ?? []);
  const reports: RedactionResult[] = [];
  const staged: StagedFile[] = [];

  // The argv is the one field that reaches the report *verbatim* — buildReport
  // puts it in the title and in the "What failed" table, so a secret typed on
  // the command line (a token passed as an argument, a home path in an input
  // path) would be published twice with no further chance to catch it.
  const redactedArgv = options.argv.map((arg) => {
    const result = redactText(arg, { surface: "command", literals });
    if (result.report.totalMatches > 0) reports.push(result);
    return result.text;
  });

  for (const entry of scan.files) {
    let content: Buffer;
    try {
      content = await readFile(entry.absolutePath);
    } catch (error) {
      warnings.push("cannot read " + entry.path + ": " + (error as Error).message);
      continue;
    }
    // Binary files are carried byte-for-byte. Redacting them would corrupt the
    // bytes for a regex over megabytes of noise.
    if (looksBinary(content)) {
      staged.push({
        path: "files/" + entry.path,
        sourcePath: entry.path,
        content,
        mode: entry.mode,
        reason: entry.reason,
        truncated: false,
      });
      continue;
    }
    const original = content.toString("utf8");
    const result = redactText(original, { surface: "files/" + entry.path, literals });
    reports.push(result);
    staged.push({
      path: "files/" + entry.path,
      sourcePath: entry.path,
      content: Buffer.from(result.text, "utf8"),
      mode: entry.mode,
      reason: entry.reason,
      truncated: false,
    });
  }

  const stdoutRedacted = redactText(execution.stdout, { surface: "logs/stdout.txt", literals });
  reports.push(stdoutRedacted);
  const stderrRedacted = redactText(execution.stderr, { surface: "logs/stderr.txt", literals });
  reports.push(stderrRedacted);

  const stdoutLimited = elideMiddle(stdoutRedacted.text, MAX_LOG_BYTES);
  const stderrLimited = elideMiddle(stderrRedacted.text, MAX_LOG_BYTES);
  if (stdoutLimited.truncated || stderrLimited.truncated) {
    warnings.push("captured output exceeded " + MAX_LOG_BYTES + " bytes and was elided");
  }

  const logs = [
    { path: join("logs", "stdout.txt"), content: Buffer.from(stdoutLimited.text, "utf8") },
    { path: join("logs", "stderr.txt"), content: Buffer.from(stderrLimited.text, "utf8") },
  ];

  if (execution.timedOut) warnings.push("command exceeded the " + timeoutMs + "ms timeout and was killed");
  if (execution.exitCode === 0 && !execution.timedOut) {
    warnings.push("command exited 0; this bundle records a success, not a failure");
  }

  await mkdir(options.out, { recursive: true });
  const written = await writeBundle({
    root: options.out,
    files: staged,
    logs,
    manifest: {
      formatVersion: 1,
      createdAt: startedAt,
      producer: { name: "repropack", version: options.toolVersion, node: process.version },
      command: {
        argv: redactedArgv,
        cwd: ".",
        startedAt,
        durationMs: execution.durationMs,
        exitCode: execution.exitCode,
        signal: execution.signal,
        stdoutPath: "logs/stdout.txt",
        stderrPath: "logs/stderr.txt",
        truncated: stdoutLimited.truncated || stderrLimited.truncated,
      },
      environment,
      repository,
      redaction: mergeReports(reports),
      warnings,
    },
  });

  // Replay artefacts are written after the manifest so a half-finished bundle
  // never looks complete to a reader that only checks for bundle.json.
  await writeExportArtifacts(options.out, written.manifest);

  return { bundle: written.manifest, root: options.out };
}

/** A NUL byte in the first 8 KB is the same heuristic git uses. */
function looksBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8000));
  for (const byte of sample) {
    if (byte === 0) return true;
  }
  return false;
}