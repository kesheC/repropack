import { mkdtemp, mkdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readBundle, type LoadedBundle } from "../bundle/read.js";
import { ARCHIVE_SUFFIX, unpackBundle } from "../archive/index.js";
import { run } from "../util/exec.js";
import { materialize } from "./materialize.js";
import { compareStderr } from "./fidelity.js";
import { reproducibleEnv } from "../capture/env.js";
import type { ReplayOptions, ReplayReason, ReplayResult } from "../types.js";

/**
 * Re-run a bundle in a clean directory.
 *
 * "Reproduced" is judged on the failure, not on the bytes: timings, temp paths
 * and random ids differ on every run, so a byte comparison would report a false
 * negative on almost every real bundle. But the exit code alone is too weak in
 * the other direction -- once capture has replaced a secret in argv with a
 * placeholder, the replayed command can fail with a completely different error
 * and still match on exit status. fidelity.ts compares the one line that names
 * the failure on each side, normalised for the differences a replay is allowed
 * to have.
 */
export async function replay(options: ReplayOptions): Promise<ReplayResult> {
  const archives: string[] = [];
  const loaded = await loadTarget(options.bundle, archives);
  const reasons: ReplayReason[] = [];

  try {
    return await runReplay(options, loaded, reasons);
  } finally {
    // Archives are unpacked into a temp dir owned by this call; a directory
    // bundle belongs to the caller and is never removed.
    for (const dir of archives) await rm(dir, { recursive: true, force: true }).catch(() => void 0);
  }
}

/**
 * Accept a bundle directory or a packed `.repropack` archive.
 *
 * The report tells people to run `repropack replay demo.repropack`, so the
 * archive path has to work with the same command; unpacking to a temp dir
 * keeps the archive read-only.
 */
async function loadTarget(target: string, archives: string[]): Promise<LoadedBundle> {
  const info = await stat(target).catch(() => null);
  const looksPacked = target.endsWith(ARCHIVE_SUFFIX) || (info !== null && info.isFile());
  if (!looksPacked) return readBundle(target);
  if (info === null) throw new Error("no such bundle or archive: " + target);

  const dir = await mkdtemp(join(tmpdir(), "repropack-unpack-"));
  archives.push(dir);
  await unpackBundle({ archive: target, out: dir });
  return readBundle(dir);
}

async function runReplay(
  options: ReplayOptions,
  loaded: LoadedBundle,
  reasons: ReplayReason[],
): Promise<ReplayResult> {
  if (!loaded.integrityOk) {
    reasons.push({ kind: "integrity", detail: loaded.problems.join("; ") });
  }

  const workdir = options.workdir ?? (await mkdtemp(join(tmpdir(), "repropack-replay-")));
  await mkdir(workdir, { recursive: true });

  const materialized = await materialize(loaded, workdir);
  // A missing or corrupted file means the replay environment is not the
  // recorded one; keep going so the user still sees the command output, but
  // never report it as a faithful reproduction.
  for (const reason of materialized.reasons) reasons.push(reason);

  const argv = loaded.manifest.command.argv;
  if (argv.length === 0) {
    await cleanup(workdir, options);
    return {
      ok: false,
      exitCode: null,
      signal: null,
      durationMs: 0,
      expectedExitCode: loaded.manifest.command.exitCode,
      reasons: [...reasons, { kind: "integrity", detail: "bundle records no command" }],
      stdout: "",
      stderr: "",
      workdir,
    };
  }

  // Only the reproducible half of the recorded environment is applied: the
  // captured PATH and HOME belong to the other machine and would either break
  // the run or silently change which binary everyone is testing.
  const env = { ...process.env, ...reproducibleEnv(loaded.manifest.environment.env) };
  const timeoutMs = options.timeoutMs ?? 300_000;
  const execution = await run(argv, { cwd: workdir, env, timeoutMs });

  if (execution.timedOut) {
    reasons.push({ kind: "timeout", timeoutMs });
  } else if (!options.ignoreExitCode && execution.exitCode !== loaded.manifest.command.exitCode) {
    reasons.push({
      kind: "exit-code",
      expected: loaded.manifest.command.exitCode,
      actual: execution.exitCode,
    });
  } else {
    // The exit code agreeing is the cheap half of the answer. A different error
    // that happens to exit 1 is the expensive half, and it is the case this tool
    // creates every time it redacts a secret out of argv: the replayed command
    // runs with REDACTED_ where a token used to be, fails on the placeholder
    // instead of the original value, and matches on exit status. Only judged
    // when the codes already agree -- an exit-code drift is the larger finding,
    // and two findings for one symptom reads as noise.
    const recorded = await readRecordedStderr(loaded);
    if (recorded !== null) {
      const drift = compareStderr(recorded, execution.stderr);
      if (drift !== null) {
        // ReplayReason is a closed union in types.ts, which is frozen: the
        // reproduction not being trustworthy is what "integrity" already means,
        // so this says so through the existing kind rather than widening a
        // contract every consumer shares.
        reasons.push({
          kind: "integrity",
          detail:
            "the replayed command failed differently: recorded " +
            quoteHeadline(drift.expected) +
            ", replayed " +
            quoteHeadline(drift.actual),
        });
      }
    }
  }

  const result: ReplayResult = {
    ok: reasons.length === 0,
    exitCode: execution.exitCode,
    signal: execution.signal,
    durationMs: execution.durationMs,
    expectedExitCode: loaded.manifest.command.exitCode,
    reasons,
    stdout: execution.stdout,
    stderr: execution.stderr,
    workdir,
  };

  await cleanup(workdir, options);

  return result;
}

/**
 * Remove the temp workdir unless the caller pinned it or asked to keep it.
 *
 * This has to run on the early returns too: the branch that refuses a bundle
 * with no command used to leave one directory behind per malformed bundle.
 */
async function cleanup(workdir: string, options: ReplayOptions): Promise<void> {
  if (options.keep || options.workdir) return;
  await rm(workdir, { recursive: true, force: true });
}

/**
 * The stderr capture recorded, or null when the bundle has no log to compare.
 *
 * A missing log is not a drift: materialize already reports a missing file, and
 * inventing a second finding for it would blame the manifest twice.
 */
async function readRecordedStderr(loaded: LoadedBundle): Promise<string | null> {
  try {
    return await readFile(join(loaded.root, "logs", "stderr.txt"), "utf8");
  } catch {
    return null;
  }
}

function quoteHeadline(headline: string): string {
  return headline.length === 0 ? "no stderr output" : '"' + headline + '"';
}

export { materialize } from "./materialize.js";