import { open, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { readBundle, type LoadedBundle } from "../bundle/read.js";
import { isUnsafeRelativePath } from "../bundle/manifest.js";
import { findResidualSecrets, isPlaceholderText } from "../redact/engine.js";
import { sha256Bytes } from "../util/hash.js";
import { formatBytes } from "../util/bytes.js";
import type { Bundle, CommandRecord, VerifyCode, VerifyFinding, VerifyResult } from "../types.js";

export interface VerifyOptions {
  /**
   * Treat warnings as failures too.
   *
   * The default answers one question — "is it safe to post this?" — so an
   * unredacted user name warns without refusing. Someone publishing on behalf
   * of a security team wants the other question instead, and a boolean they can
   * put in CI has to include the warnings.
   */
  readonly strict?: boolean;
}

/** Read cap. Anything larger is sampled from the head, never loaded whole. */
const MAX_SAMPLE_BYTES = 2 * 1024 * 1024;
/** Above this, a single file turns replay into a download. */
const OVERSIZE_FILE_BYTES = 1024 * 1024;
/** Above this the bundle stops being paste-able. */
const OVERSIZE_BUNDLE_BYTES = 25 * 1024 * 1024;

/** Higher severity sorts first; the ranks never reach the output. */
const SEVERITY_RANK: Record<VerifyFinding["severity"], number> = {
  blocker: 0,
  warning: 1,
  note: 2,
};

/**
 * Shells whose argv cannot describe the command that actually ran.
 *
 * Capture records argv with shell:false. Once a shell is argv[0] the real
 * command is buried in a string only that shell knows how to split, and replay
 * would re-split it with whatever shell the next machine happens to ship.
 */
const SHELL_BASENAMES = new Set([
  "sh",
  "bash",
  "dash",
  "zsh",
  "ksh",
  "mksh",
  "fish",
  "csh",
  "tcsh",
  "cmd",
  "powershell",
  "pwsh",
  "busybox",
]);

/**
 * The redaction rule that also matches home paths.
 *
 * Home paths get their own finding at warning severity, so this rule is left
 * out of the residual scan: otherwise the same bytes produce a blocker and a
 * warning at once, and the warning can never be read on its own.
 */
const HOME_RULE = "user-home-path";

/**
 * A real user name is the first segment after a home root. "Users" is also a
 * structural container on Windows and macOS, so the segment after it is not
 * always a person — reporting Public or Default would put a warning on every
 * healthy Windows bundle.
 */
const HOME_PATH_PATTERN = /(?:[A-Za-z]:[\\/]Users[\\/]|\/(?:home|Users)\/)([^\\/\s"'\x60<>|]+)/g;
const NON_PERSONAL_HOME_NAMES = new Set(["public", "default", "default user", "all users", "guest", "shared"]);

/**
 * Absolute paths: POSIX with at least two segments (a bare /tmp is too common to
 * be a signal) and Windows drive-letter form.
 *
 * The lookbehind is what keeps this usable — without it every URL, date and
 * 12:30:00 timestamp becomes a "path" and the note turns into noise nobody
 * reads.
 */
const ABSOLUTE_PATH_PATTERN =
  /(?<![\w:/\\<])(?:[A-Za-z]:[\\/](?:[A-Za-z0-9_.@+-]+[\\/])*[A-Za-z0-9_.@+-]+|\/(?:[A-Za-z0-9_.@+-]+\/)+[A-Za-z0-9_.@+-]+)/g;

type AddFinding = (
  severity: VerifyFinding["severity"],
  code: VerifyCode,
  message: string,
  path?: string,
) => void;

/** A regular file found under files/ or logs/. */
interface DiskFile {
  /** Path relative to the surface directory, e.g. "src/app.ts". */
  readonly rel: string;
  /** Path as a finding should show it, e.g. "files/src/app.ts". */
  readonly display: string;
  readonly abs: string;
  readonly size: number;
}

/**
 * Audit a finished bundle before it leaves the machine.
 *
 * Two jobs, one entry point. Fidelity: a manifest that disagrees with its
 * payload, or a command that cannot be expressed as an argv, wastes a
 * maintainer's afternoon instead of reproducing anything. Secrecy: redaction
 * already ran at capture time, so anything caught here is a second line of
 * defence — a bundle assembled by hand, by an older version, or by a code path
 * that skipped the engine must still be stopped before it is posted.
 *
 * Findings name the rule, the surface and the hit count but never the matched
 * text. This report tends to end up in the very issue the secret must not
 * reach, so quoting the match would move the leak rather than report it.
 *
 * Never throws for a bad bundle: an audit that crashes tells the user nothing,
 * and to a careless caller a crash looks much like "no findings".
 */
export async function verifyBundle(root: string, options: VerifyOptions = {}): Promise<VerifyResult> {
  const strict = options.strict === true;
  const findings: VerifyFinding[] = [];
  const add: AddFinding = (severity, code, message, path) => {
    findings.push(path === undefined ? { severity, code, message } : { severity, code, message, path });
  };

  let loaded: LoadedBundle;
  try {
    loaded = await readBundle(root);
  } catch (error) {
    // Without a manifest there is nothing to audit against, so every other check
    // would be guesswork. Say so and stop.
    add("blocker", "integrity-mismatch", describeLoadFailure(error), "bundle.json");
    return finish(findings, strict);
  }

  checkManifest(loaded, add);
  checkCommand(loaded.manifest.command, add);

  const fileTree = await collectFiles(join(root, "files"), "files", add);
  const logTree = await collectFiles(join(root, "logs"), "logs", add);

  checkListedFiles(loaded, fileTree, add);
  await checkTotalSize(root, [...fileTree, ...logTree], add);

  const expected = expectedHashes(loaded.manifest);
  for (const file of fileTree) await inspectFile(file, expected.get(file.rel), add);
  for (const file of logTree) await inspectFile(file, undefined, add);

  return finish(findings, strict);
}

/* ------------------------------------------------------------------ */
/* Checks                                                              */
/* ------------------------------------------------------------------ */

/**
 * readBundle folds shape problems and the integrity comparison into one list,
 * so it is reported as-is. The second branch only covers a reader that reports
 * the mismatch out of band, which keeps us correct either way.
 */
function checkManifest(loaded: LoadedBundle, add: AddFinding): void {
  for (const problem of loaded.problems) {
    add("blocker", "integrity-mismatch", "manifest problem: " + problem, "bundle.json");
  }
  if (!loaded.integrityOk && !loaded.problems.some((problem) => problem.startsWith("integrity mismatch"))) {
    add("blocker", "integrity-mismatch", "manifest integrity hash does not match its own payload", "bundle.json");
  }
}

/** A bundle whose command cannot be replayed verbatim describes a repro; it is not one. */
function checkCommand(command: CommandRecord | undefined, add: AddFinding): void {
  const argv = Array.isArray(command?.argv) ? command.argv : [];
  const first: unknown = argv[0];
  if (argv.length === 0 || typeof first !== "string" || first.length === 0) {
    add("blocker", "no-reproducible-command", "command.argv is empty; there is nothing to replay", "bundle.json");
    return;
  }

  const basename = first.split(/[\\/]/).pop()?.toLowerCase() ?? "";
  const normalized = basename.endsWith(".exe") ? basename.slice(0, -4) : basename;
  if (SHELL_BASENAMES.has(normalized)) {
    add(
      "blocker",
      "no-reproducible-command",
      'argv[0] is the shell "' + normalized + '"; a shell string gets re-split by whatever shell replay finds, ' +
        "so the bundle records the shell instead of the command",
      "bundle.json",
    );
  }
}

/** Every entry the manifest claims must exist under files/. */
function checkListedFiles(loaded: LoadedBundle, fileTree: readonly DiskFile[], add: AddFinding): void {
  const entries = Array.isArray(loaded.manifest.files) ? loaded.manifest.files : [];
  const onDisk = new Set(fileTree.map((file) => file.rel));

  for (const entry of entries) {
    if (typeof entry?.path !== "string") continue;
    // An unsafe path is already a blocker from the shape check, and joining one
    // would be the very traversal that check exists to stop.
    if (isUnsafeRelativePath(entry.path)) continue;
    if (onDisk.has(entry.path)) continue;
    add("blocker", "missing-file", "listed in the manifest but absent from files/; replay will fail on it", "files/" + entry.path);
  }
}

/** Manifest hashes indexed by their path inside files/. */
function expectedHashes(manifest: Bundle): Map<string, string> {
  const map = new Map<string, string>();
  for (const entry of manifest.files) {
    if (typeof entry?.path !== "string" || typeof entry.sha256 !== "string") continue;
    if (isUnsafeRelativePath(entry.path)) continue;
    map.set(entry.path, entry.sha256);
  }
  return map;
}

/**
 * Whole-bundle weight: the two payload trees plus the generated top-level
 * scripts, which is what a maintainer actually downloads.
 */
async function checkTotalSize(root: string, surfaces: readonly DiskFile[], add: AddFinding): Promise<void> {
  let total = 0;
  for (const file of surfaces) total += file.size;

  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return; // an unreadable root is reported by collectFiles already
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    try {
      total += (await stat(join(root, entry.name))).size;
    } catch {
      // A file we cannot size contributes nothing; bundle.json is audited above.
    }
  }

  if (total > OVERSIZE_BUNDLE_BYTES) {
    add(
      "warning",
      "oversize",
      "bundle payload totals " + formatBytes(total) + ", above the " + formatBytes(OVERSIZE_BUNDLE_BYTES) + " threshold",
      ".",
    );
  }
}

/**
 * Content checks for one surface file: size, payload hash, then the text rules.
 *
 * Only files/ and logs/ are scanned. bundle.json is hash-verified and its paths
 * shape-checked but never pattern-scanned: repository.root is *meant* to be
 * absolute, so scanning the manifest would put an absolute-path note on every
 * healthy bundle and teach people to ignore the check.
 */
async function inspectFile(file: DiskFile, expected: string | undefined, add: AddFinding): Promise<void> {
  if (file.size > OVERSIZE_FILE_BYTES) {
    add(
      "warning",
      "oversize",
      formatBytes(file.size) + " is above the " + formatBytes(OVERSIZE_FILE_BYTES) + " per-file replay budget",
      file.display,
    );
  }

  const sample = await readSample(file.abs, file.display, add);
  if (sample === null) return;

  // Hashing the bytes we already hold is nearly free, and it catches the one
  // thing readBundle cannot: a payload changed on disk after the manifest was
  // written. Only possible for files we read in full.
  if (expected !== undefined && sample.complete) {
    const actual = sha256Bytes(sample.bytes);
    if (actual !== expected) {
      add(
        "blocker",
        "integrity-mismatch",
        "content hash does not match its manifest entry; the payload changed after capture, so replay would " +
          "rebuild something that never ran",
        file.display,
      );
    }
  }

  for (const hit of findResidualSecrets(sample.text)) {
    if (hit.rule === HOME_RULE) continue; // reported below, at warning severity
    add(
      "blocker",
      "leak-suspected",
      'redaction rule "' +
        hit.rule +
        '" still matches ' +
        plural(hit.count, "time", "times") +
        "; this surface must not be published as it stands",
      file.display,
    );
  }

  // Path heuristics stay off binary content: bytes that merely look like a path
  // are noise, while a secret embedded in a blob is still a secret and is
  // reported above.
  if (sample.binary) return;

  const homeNames = new Set<string>();
  let homeMatches = 0;
  for (const match of sample.text.matchAll(HOME_PATH_PATTERN)) {
    const name = match[1];
    if (name === undefined) continue;
    // A placeholder is the fix, not the leak: capture already replaced this
    // segment. Treating it as a name would warn on every bundle captured from a
    // home directory, which is most of them.
    if (isPlaceholderText(name)) continue;
    if (NON_PERSONAL_HOME_NAMES.has(name.toLowerCase())) continue;
    homeMatches += 1;
    homeNames.add(name);
  }
  if (homeNames.size > 0) {
    add(
      "warning",
      "user-home-leak",
      "a home path exposes " +
        describeNames([...homeNames]) +
        " (" +
        plural(homeMatches, "occurrence", "occurrences") +
        "); a bundle carrying a real user name should not be posted publicly",
      file.display,
    );
  }

  const absolute = sample.text.match(ABSOLUTE_PATH_PATTERN) ?? [];
  if (absolute.length > 0) {
    add(
      "note",
      "absolute-path",
      plural(absolute.length, "absolute path", "absolute paths") +
        " (first: " +
        quote(absolute[0] ?? "") +
        "); usually harmless, but they only resolve on the capture machine",
      file.display,
    );
  }
}

/* ------------------------------------------------------------------ */
/* Filesystem helpers                                                  */
/* ------------------------------------------------------------------ */

/**
 * Walk one surface directory and collect regular files.
 *
 * Symlinks are skipped rather than followed: capture never writes them, and
 * following one would let a bundle make verify read a file outside itself.
 */
async function collectFiles(dir: string, surface: string, add: AddFinding): Promise<DiskFile[]> {
  const out: DiskFile[] = [];

  async function walk(abs: string, rel: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(abs, { withFileTypes: true });
    } catch (error) {
      const code = errorCode(error);
      // An absent surface is normal: a bundle with no logs still verifies.
      if (rel === "" && (code === "ENOENT" || code === "ENOTDIR")) return;
      add("blocker", "integrity-mismatch", "cannot list this directory (" + code + ")", rel === "" ? surface : surface + "/" + rel);
      return;
    }

    for (const entry of entries) {
      const childAbs = join(abs, entry.name);
      const childRel = rel === "" ? entry.name : rel + "/" + entry.name;
      if (entry.isDirectory()) {
        await walk(childAbs, childRel);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        out.push({
          rel: childRel,
          display: surface + "/" + childRel,
          abs: childAbs,
          size: (await stat(childAbs)).size,
        });
      } catch (error) {
        add("blocker", "integrity-mismatch", "cannot stat this file (" + errorCode(error) + ")", surface + "/" + childRel);
      }
    }
  }

  await walk(dir, "");
  return out;
}

interface Sample {
  readonly bytes: Buffer;
  readonly text: string;
  /** Contains a NUL byte, so the binary heuristics stay off. */
  readonly binary: boolean;
  /** True when bytes is the whole file, which is what makes hashing meaningful. */
  readonly complete: boolean;
}

/**
 * Read at most MAX_SAMPLE_BYTES from the head of a file.
 *
 * Reading whole files would let one huge log decide how much memory verify
 * needs, and the head is where tool output and stack traces live anyway.
 */
async function readSample(abs: string, display: string, add: AddFinding): Promise<Sample | null> {
  let handle;
  try {
    handle = await open(abs, "r");
  } catch (error) {
    add("blocker", "integrity-mismatch", "cannot open this file (" + errorCode(error) + ")", display);
    return null;
  }

  try {
    const size = (await handle.stat()).size;
    // alloc, not allocUnsafe: bytes past what we read must never end up in a
    // string we then run secret regexes over.
    const buffer = Buffer.alloc(Math.min(MAX_SAMPLE_BYTES, Math.max(0, size)));
    let filled = 0;
    while (filled < buffer.length) {
      const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, filled);
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    const bytes = buffer.subarray(0, filled);
    return {
      bytes,
      text: bytes.toString("utf8"),
      binary: bytes.includes(0),
      complete: bytes.length === size,
    };
  } catch (error) {
    add("blocker", "integrity-mismatch", "cannot read this file (" + errorCode(error) + ")", display);
    return null;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/* ------------------------------------------------------------------ */
/* Result assembly                                                     */
/* ------------------------------------------------------------------ */

/**
 * Sort, dedupe, decide.
 *
 * Order is severity, then code, then path, then message. The message key is not
 * decoration: several findings share one path, and a stable total order is what
 * makes the same bundle produce byte-identical output.
 */
function finish(findings: readonly VerifyFinding[], strict: boolean): VerifyResult {
  const sorted = [...findings].sort(compareFindings);
  const unique: VerifyFinding[] = [];
  const seen = new Set<string>();

  for (const finding of sorted) {
    const key = [finding.severity, finding.code, finding.path ?? "", finding.message].join("\u0000");
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(finding);
  }

  const blocked = unique.some((finding) => finding.severity === "blocker");
  const warned = unique.some((finding) => finding.severity === "warning");
  return { ok: !blocked && !(strict && warned), findings: unique };
}

function compareFindings(a: VerifyFinding, b: VerifyFinding): number {
  const bySeverity = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
  if (bySeverity !== 0) return bySeverity;
  if (a.code !== b.code) return a.code < b.code ? -1 : 1;
  const aPath = a.path ?? "";
  const bPath = b.path ?? "";
  if (aPath !== bPath) return aPath < bPath ? -1 : 1;
  if (a.message === b.message) return 0;
  return a.message < b.message ? -1 : 1;
}

/* ------------------------------------------------------------------ */

function describeLoadFailure(error: unknown): string {
  const code = errorCode(error);
  if (code !== "UNKNOWN") return "bundle.json could not be read (" + code + "); this is not a usable bundle";
  return "bundle.json could not be read: " + (error instanceof Error ? error.message : String(error));
}

function errorCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === "string" && code.length > 0 ? code : "UNKNOWN";
}

function plural(count: number, one: string, many: string): string {
  return count + " " + (count === 1 ? one : many);
}

function describeNames(names: readonly string[]): string {
  const shown = names.slice(0, 3).map((name) => '"' + name + '"');
  const extra = names.length - shown.length;
  return extra > 0 ? shown.join(", ") + " and " + extra + " more user name(s)" : shown.join(", ");
}

/** Keep a sample readable on one line without echoing a whole path. */
function quote(text: string): string {
  const clipped = text.length > 60 ? text.slice(0, 59) + "\u2026" : text;
  return '"' + clipped + '"';
}
