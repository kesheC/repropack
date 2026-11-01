/**
 * Was the failure that came back the failure that was recorded?
 *
 * Exit codes alone are not enough. capture redacts the command line before it
 * stores it, so a command that took a token as an argument runs on the replaying
 * machine with a placeholder where the token was. It still fails, and it still
 * exits non-zero, but it fails for a different reason -- and a reproduction tool
 * that calls that "replayed faithfully" is worse than one that says nothing.
 *
 * Both sides are normalised before they are compared, because the differences a
 * replay is *allowed* to have are exactly the ones a byte comparison trips over:
 * a different temp directory, different line numbers, durations, uuids and the
 * REDACTED_ placeholders capture substituted for secrets.
 */
export interface StderrDrift {
  readonly expected: string;
  readonly actual: string;
}

const ANSI_ESCAPE = /\u001b\[[0-9;]*[A-Za-z]/g;
const PLACEHOLDER = /REDACTED_[A-Z0-9_]+/g;
const FILE_URL = /file:\/\/\/[^\s"')]+/g;
const WINDOWS_PATH = /[A-Za-z]:[\\/][^\s"')]*/g;
const POSIX_PATH = /(^|[\s("'=])\/[^\s"')]+/g;
const TEMP_DIR = /(?:repropack-replay|repropack-unpack|tmp)\.[A-Za-z0-9]+/g;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const DURATION = /\b\d+(?:\.\d+)?\s?(?:ms|milliseconds?|secs?|seconds?|s)\b/gi;
const LINE_COL = /:\d+:\d+/g;

/**
 * The one line that names the failure, normalised for comparison.
 *
 * Node prints a file URL and a source excerpt above the message, Python prints a
 * "Traceback" header, Go prints "goroutine": none of those lines are the failure,
 * they are the frames around it. Everything that is indented, is a bare path, or
 * is a known banner is skipped; the last non-empty line is the fallback for
 * output that follows none of those conventions.
 */
export function errorHeadline(text: string): string | null {
  const lines = text.replace(ANSI_ESCAPE, "").split(/\r?\n/);
  let fallback: string | null = null;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    fallback = trimmed;
    if (isHeadline(line)) return normalise(trimmed);
  }
  return fallback === null ? null : normalise(fallback);
}

function isHeadline(line: string): boolean {
  if (/^\s/.test(line)) return false; // stack frame, source excerpt, continuation
  if (/^(?:at|Traceback|During handling|The above exception)/.test(line)) return false;
  if (/^(?:file|https?|node):\/\//.test(line)) return false;
  if (/^[A-Za-z]:[\\/]/.test(line)) return false;
  if (/^\//.test(line)) return false;
  if (/^\^+$/.test(line)) return false;
  return true;
}

function normalise(text: string): string {
  let out = text.replace(PLACEHOLDER, "<redacted>");
  out = out.replace(FILE_URL, "<path>");
  out = out.replace(WINDOWS_PATH, "<path>");
  out = out.replace(TEMP_DIR, "<tmp>");
  out = out.replace(POSIX_PATH, (_match: string, lead: string) => lead + "<path>");
  out = out.replace(UUID, "<uuid>");
  out = out.replace(DURATION, "<duration>");
  out = out.replace(LINE_COL, ":<line>");
  return out.replace(/\s+/g, " ").trim().slice(0, 200);
}

/**
 * Null when the two failures say the same thing, both headlines when they do not.
 * An empty side means that run produced no output at all, which is itself a
 * difference worth reporting rather than assuming.
 */
export function compareStderr(recorded: string, replayed: string): StderrDrift | null {
  const expected = errorHeadline(recorded);
  const actual = errorHeadline(replayed);
  if (expected === actual) return null;
  return { expected: expected ?? "", actual: actual ?? "" };
}
