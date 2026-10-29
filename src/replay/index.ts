import { mkdtemp, mkdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readBundle, type LoadedBundle } from "../bundle/read.js";
import { ARCHIVE_SUFFIX, unpackBundle } from "../archive/index.js";
import { run } from "../util/exec.js";
import { materialize } from "./materialize.js";
import { reproducibleEnv } from "../capture/env.js";
import type { ReplayOptions, ReplayReason, ReplayResult } from "../types.js";

/**
 * Re-run a bundle in a clean directory.
 *
 * "Reproduced" means the same exit code, not the same output: timings, temp
 * paths and random ids differ on every run, so comparing stdout byte-for-byte
 * would report a false negative on almost every real bundle.
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

  if (!options.keep && !options.workdir) {
    await rm(workdir, { recursive: true, force: true });
  }

  return result;
}

export { materialize } from "./materialize.js";