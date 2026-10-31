import { spawn } from "node:child_process";

export interface RunResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

export interface RunOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  /** Bytes of stdout/stderr to retain; the rest is dropped and flagged. */
  maxLogBytes?: number;
  stdin?: string;
}

/**
 * Run a command without a shell and capture its output.
 *
 * No shell on purpose: the argv we record in the bundle has to be the argv we
 * actually ran, byte for byte. A shell string would let quoting, globbing and
 * env expansion change the meaning between capture and replay.
 */
export async function run(argv: readonly string[], options: RunOptions): Promise<RunResult> {
  const [cmd, ...args] = argv;
  if (!cmd) throw new Error("run(): argv must contain at least a command");

  const started = Date.now();
  const maxLogBytes = options.maxLogBytes ?? 8 * 1024 * 1024;
  let stdout = "";
  let stderr = "";
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let timedOut = false;

  const child = spawn(cmd, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    shell: false,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });

  const timer = options.timeoutMs
    ? setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, options.timeoutMs)
    : null;

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    const size = Buffer.byteLength(chunk, "utf8");
    if (stdoutBytes + size > maxLogBytes) {
      const room = Math.max(0, maxLogBytes - stdoutBytes);
      if (room > 0) stdout += chunk.slice(0, room);
      stdoutBytes = maxLogBytes;
      return;
    }
    stdoutBytes += size;
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    const size = Buffer.byteLength(chunk, "utf8");
    if (stderrBytes + size > maxLogBytes) {
      const room = Math.max(0, maxLogBytes - stderrBytes);
      if (room > 0) stderr += chunk.slice(0, room);
      stderrBytes = maxLogBytes;
      return;
    }
    stderrBytes += size;
    stderr += chunk;
  });

  if (options.stdin !== undefined) child.stdin.end(options.stdin);
  else child.stdin.end();

  // The timer has to be cleared on every exit path. When spawn fails (ENOENT for
  // a command that does not exist) the promise rejects, and a clearTimeout placed
  // after the await would be skipped -- leaving a pending timer that keeps the
  // process alive until the full timeout elapses, so a capture that failed in
  // 200ms would still hang for the whole --timeout. finally is the only placement
  // that covers resolve, reject and a thrown listener alike.
  let code: number | null;
  let sig: NodeJS.Signals | null;
  try {
    ({ code, sig } = await new Promise<{ code: number | null; sig: NodeJS.Signals | null }>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (exitCode, signal) => resolve({ code: exitCode, sig: signal }));
    }));
  } finally {
    if (timer) clearTimeout(timer);
  }

  return {
    exitCode: code,
    signal: sig,
    stdout,
    stderr,
    durationMs: Date.now() - started,
    timedOut,
  };
}

/** Run a command and return only its trimmed stdout; throws on non-zero exit. */
export async function runCapture(argv: readonly string[], options: RunOptions): Promise<string> {
  const result = await run(argv, options);
  if (result.exitCode !== 0) {
    throw new Error(
      "command failed (" + argv.join(" ") + "): exit " + String(result.exitCode) + " " + result.stderr.trim().slice(0, 400),
    );
  }
  return result.stdout.trim();
}

/**
 * Like `runCapture` but returns null instead of throwing when the command is
 * missing or exits non-zero. Used for opportunistic probes (`git describe`,
 * `npm --version`) where absence is a normal, reportable state.
 */
export async function tryCapture(argv: readonly string[], options: RunOptions): Promise<string | null> {
  try {
    const result = await run(argv, options);
    if (result.exitCode !== 0) return null;
    return result.stdout.trim();
  } catch {
    return null;
  }
}
