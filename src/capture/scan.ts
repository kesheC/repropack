import { readFile, readdir, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { run, tryCapture } from "../util/exec.js";
import { findRepoRoot } from "./git.js";
import { collectLocalImports } from "./closure.js";
import type { CaptureScope, FileReason } from "../types.js";

/** A file that will be considered for the bundle. */
export interface ScanEntry {
  /** POSIX path relative to the scan root. */
  path: string;
  absolutePath: string;
  bytes: number;
  mode: "100644" | "100755";
  reason: FileReason;
}

export interface ScanOptions {
  cwd: string;
  scope: CaptureScope;
  include?: readonly string[];
  exclude?: readonly string[];
  /** Bundle directory being written; never bundled even when it sits under `cwd`. */
  outDir?: string;
  maxFileBytes?: number;
  maxBundleBytes?: number;
  /** Paths referenced by stack traces; they are kept even if otherwise ignored. */
  stackFramePaths?: readonly string[];
}

export interface ScanResult {
  root: string;
  files: readonly ScanEntry[];
  warnings: readonly string[];
  totalBytes: number;
}

/**
 * Directories never worth walking.
 *
 * These are either enormous, generated, or both. Skipping by name (rather than
 * by `.gitignore` alone) is deliberate: a fresh clone without a lockfile still
 * has a `node_modules` after `npm install`, and walking it can take minutes.
 */
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  "coverage",
  ".next",
  ".nuxt",
  ".output",
  ".venv",
  "venv",
  "__pycache__",
  ".mypy_cache",
  ".pytest_cache",
  ".ruff_cache",
  "target",
  "vendor",
  ".repropack",
  ".turbo",
  ".cache",
  ".idea",
  ".vscode",
]);

// 256 KiB per file, 8 MiB per bundle: a bundle is meant to be attached to a
// bug report without a file host, and a single generated lockfile or minified
// blob must not eat the whole budget.
const DEFAULT_MAX_FILE_BYTES = 256 * 1024;
const DEFAULT_MAX_BUNDLE_BYTES = 8 * 1024 * 1024;
const MAX_FILES = 2000;

/**
 * Enumerate the worktree files a bundle should carry.
 *
 * Ordering is deterministic (lexicographic by relative path) because the
 * bundle id is derived from the file hashes: an unstable order would make two
 * captures of the same failure produce different ids.
 */
export async function scanWorktree(options: ScanOptions): Promise<ScanResult> {
  // The scan root is the working directory, never the repository root. A
  // capture run from 'packages/api' must describe 'packages/api': walking up
  // to the repository root would ship every unrelated project in the
  // monorepo, and for a nested checkout (a project inside a checkout of
  // itself) that is exactly what happened before this line was rewritten.
  const root = resolve(options.cwd);
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const maxBundleBytes = options.maxBundleBytes ?? DEFAULT_MAX_BUNDLE_BYTES;

  const warnings: string[] = [];
  const includeGlobs = (options.include ?? []).map(toMatcher);
  const excludeGlobs = (options.exclude ?? []).map(toMatcher);

  const repoRoot = await findRepoRoot(root);
  // git speaks repository-relative paths; the walk speaks cwd-relative ones.
  // Everything git reports is translated through this prefix, and anything
  // outside the scan root is dropped rather than passed through.
  //
  // The prefix comes from git itself (`rev-parse --show-prefix`) rather than
  // from path arithmetic. On Windows the two spellings of the same directory
  // differ — 8.3 short names, drive-letter case, forward vs back slashes — and
  // `relative()` happily returns "../../.." for a path that is literally the
  // same, which mapped every git path to "outside the scan root" and produced
  // an empty bundle with no warning.
  const repoPrefix = repoRoot ? await showPrefix(root) : "";
  const toScanPath =
    repoPrefix === ""
      ? (repoRelative: string): string => repoRelative
      : (repoRelative: string): string | null => {
          if (!repoRelative.startsWith(repoPrefix)) return null;
          return repoRelative.slice(repoPrefix.length);
        };

  // Names are matched case-insensitively on purpose: the same checkout is
  // reachable from a case-preserving shell and a case-folding one. Both the
  // repository and the scan root can carry ignore entries that apply here.
  const gitignoredDirs = new Set([
    ...(await readGitignoreDirs(root)),
    ...(repoRoot && repoRoot !== root ? await readGitignoreDirs(repoRoot) : []),
  ]);
  const skipDir = (name: string): boolean =>
    SKIP_DIRS.has(name.toLowerCase()) || gitignoredDirs.has(name.toLowerCase());

  // Outside a repository there is no baseline to diff against, so a git-backed
  // scope has to degrade to "everything" — selecting nothing would silently
  // produce an empty bundle, which is worse than a large one.
  const keepWithinRoot = (raw: Set<string>): Set<string> => {
    const out = new Set<string>();
    for (const path of raw) {
      const mapped = toScanPath(path);
      if (mapped !== null) out.add(mapped);
    }
    return out;
  };
  const changed = options.scope === "changed" && repoRoot ? keepWithinRoot(await listChanged(repoRoot, warnings)) : null;
  const tracked = options.scope === "tracked" && repoRoot ? keepWithinRoot(await listTracked(repoRoot, warnings)) : null;
  if (!repoRoot && (options.scope === "changed" || options.scope === "tracked")) {
    warnings.push(
      "not a git repository: scope \"" + options.scope + "\" falls back to every unignored file",
    );
  }

  // The bundle directory can live inside the project it describes. First
  // capture writes it after the walk; a second capture would otherwise bundle
  // the first bundle.
  const outRelative = options.outDir ? toPosix(relative(root, resolve(options.outDir))) : null;
  const skipGenerated =
    outRelative !== null && outRelative !== "" && !outRelative.startsWith("..") && !isAbsolute(outRelative)
      ? outRelative
      : null;

  // Stack frames name the line that threw, not the modules it called. Widen the
  // seed set to the local import closure so a minimal bundle can actually run:
  // replaying a one-file bundle dies on ERR_MODULE_NOT_FOUND and then only
  // "reproduces" the recorded exit code for the wrong reason.
  const stackFrames = new Set((options.stackFramePaths ?? []).map(normalizeToRoot(root)));
  if (stackFrames.size > 0) {
    // The closure resolves against the set of shipable paths, so node_modules,
    // ignored directories and the bundle's own output stay out by construction.
    const walkable = await listWalkable(root, skipDir, excludeGlobs, skipGenerated);
    const seeds = [...stackFrames].filter((path) => walkable.has(path));
    for (const path of await collectLocalImports({ root, seeds, known: walkable })) stackFrames.add(path);
  }

  const files: ScanEntry[] = [];
  let totalBytes = 0;
  let omittedForBudget = 0;
  let truncated = false;
  const visitedDirs = new Set<string>();

  const walk = async (dir: string): Promise<void> => {
    if (truncated) return;
    const realDir = resolve(dir);
    if (visitedDirs.has(realDir)) return;
    visitedDirs.add(realDir);

    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      warnings.push("cannot list " + relative(root, dir) + ": " + (error as Error).message);
      return;
    }

    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    for (const entry of entries) {
      if (truncated) return;
      const absolute = join(dir, entry.name);
      const rel = toPosix(relative(root, absolute));

      if (entry.isSymbolicLink()) {
        warnings.push("skipped symlink: " + rel);
        continue;
      }
      if (entry.isDirectory()) {
        if (skipDir(entry.name)) continue;
        if (skipGenerated !== null && (rel === skipGenerated || rel.startsWith(skipGenerated + "/"))) continue;
        if (excludeGlobs.some((m) => m(rel))) continue;
        await walk(absolute);
        continue;
      }
      if (!entry.isFile()) continue;

      if (excludeGlobs.some((m) => m(rel))) continue;

      const fromStack = stackFrames.has(rel);
      const fromInclude = includeGlobs.some((m) => m(rel));
      // `include` and stack-frame paths widen every scope: they are the
      // caller saying "this file is why the failure reproduces", and a scope
      // filter that quietly drops them would ship a bundle missing its input.
      if (!fromStack && !fromInclude) {
        if (changed && !changed.has(rel)) continue;
        if (tracked && !tracked.has(rel)) continue;
      }

      let info;
      try {
        info = await stat(absolute);
      } catch (error) {
        warnings.push("cannot stat " + rel + ": " + (error as Error).message);
        continue;
      }
      if (info.size > maxFileBytes) {
        warnings.push("skipped large file: " + rel + " (" + info.size + " bytes > " + maxFileBytes + ")");
        continue;
      }
      if (files.length >= MAX_FILES) {
        warnings.push("file count budget reached (" + MAX_FILES + " files); later files omitted");
        truncated = true;
        return;
      }
      if (totalBytes + info.size > maxBundleBytes) {
        // Not a hard stop: a 3 MB file early in the walk must not hide the
        // remaining 5 KB files that might contain the failing input.
        omittedForBudget += 1;
        continue;
      }

      totalBytes += info.size;
      files.push({
        path: rel,
        absolutePath: absolute,
        bytes: info.size,
        mode: (info.mode & 0o111) !== 0 ? "100755" : "100644",
        reason: reasonFor({ fromStack, fromInclude }),
      });
    }
  };

  await walk(root);
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  if (omittedForBudget > 0) {
    warnings.push(
      "bundle size budget reached (" + maxBundleBytes + " bytes): " + omittedForBudget + " later file(s) omitted",
    );
  }

  return { root, files, warnings, totalBytes };
}

/**
 * Why a file earned its place. Order matters: a file matched by an include
 * glob is an input even when it also changed, because dropping it breaks the
 * repro while dropping a changed neighbour only loses context.
 */
function reasonFor(input: { fromStack: boolean; fromInclude: boolean }): FileReason {
  if (input.fromInclude) return "input";
  if (input.fromStack) return "stack-frame";
  // Reached through `tracked`/`all` with no other marker. The file is only
  // "changed" in the weak sense that selection, not the repo, put it here.
  return "changed";
}

/**
 * Changed paths, as git reports them (POSIX separators, repo-relative).
 *
 * `--untracked-files=all` and `-z` are both load-bearing:
 * - without `all`, an untracked directory is collapsed to a single `dir/`
 *   entry, and a scope that only knows about `dir/` selects nothing at all;
 * - without `-z`, a path containing a newline or a quote is printed C-quoted,
 *   so the set would hold `"a\\nb.txt"` instead of the real name.
 */
/**
 * Where the scan root sits inside the repository, as git spells it.
 *
 * Returns "" at the top level and "sub/dir/" below it, always with a trailing
 * slash so the caller can slice without re-checking the boundary.
 */
async function showPrefix(root: string): Promise<string> {
  const raw = await tryCapture(["git", "rev-parse", "--show-prefix"], { cwd: root, timeoutMs: 15_000 });
  if (raw === null) return "";
  const trimmed = raw.trim();
  if (trimmed === "" || trimmed === "./") return "";
  return toPosix(trimmed.endsWith("/") ? trimmed : trimmed + "/");
}

async function listChanged(repoRoot: string, warnings: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  let raw: string;
  try {
    const result = await run(["git", "status", "--porcelain", "-z", "--untracked-files=all"], {
      cwd: repoRoot,
      timeoutMs: 20_000,
    });
    if (result.exitCode !== 0) {
      // Returning an empty set here would produce an empty bundle that looks
      // like a successful capture, so say what happened.
      warnings.push("git status failed (" + firstLine(result.stderr) + "); scope \"changed\" is empty");
      return out;
    }
    raw = result.stdout;
  } catch (error) {
    warnings.push("git status failed (" + (error as Error).message + "); scope \"changed\" is empty");
    return out;
  }
  // Record layout: "XY <path>" then NUL. A rename or copy record is followed
  // by a second NUL-terminated field holding the original path; that extra
  // field must be consumed, or it parses as a bare path with no status.
  const fields = raw.split("\u0000");
  for (let i = 0; i < fields.length; i += 1) {
    const field = fields[i];
    if (!field || field.length < 4) continue;
    const status = field.slice(0, 2);
    const path = field.slice(3);
    if (status.includes("R") || status.includes("C")) i += 1;
    // The file on disk is the destination of a rename, never the source.
    if (path) out.add(path);
  }
  return out;
}

/**
 * Tracked paths, as git reports them (POSIX separators, repo-relative).
 *
 * `--full-name` keeps the output repo-relative when git runs from a
 * subdirectory of the repository; the caller maps it back to the scan root.
 */
async function listTracked(repoRoot: string, warnings: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  const raw = await tryCapture(["git", "ls-files", "-z", "--full-name"], { cwd: repoRoot, timeoutMs: 30_000 });
  if (!raw) {
    warnings.push("git ls-files failed; scope \"tracked\" is empty");
    return out;
  }
  for (const path of raw.split("\u0000")) {
    if (path) out.add(path);
  }
  return out;
}

/**
 * Top-level directory names excluded by the repository .gitignore.
 *
 * This is deliberately not a gitignore implementation: the matcher below is a
 * 30-line glob compiler, and full gitignore semantics (negation order,
 * nested files, `**`) would be a dependency we promised not to add. Reading
 * only root-anchored directory lines catches the entries that actually
 * matter for walk cost, and a missed entry is the safe direction to fail: it
 * means we walk a directory we could have skipped, never that we ship a file
 * the user excluded.
 */
async function readGitignoreDirs(root: string): Promise<Set<string>> {
  const out = new Set<string>();
  let raw: string;
  try {
    raw = await readFile(join(root, ".gitignore"), "utf8");
  } catch {
    return out;
  }
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("!")) continue;
    if (!trimmed.endsWith("/")) continue;
    const name = trimmed.replace(/^\//, "").replace(/\/$/, "");
    // Anything but a bare name needs real gitignore semantics to resolve.
    if (!name || name.includes("/") || /[*?[\]\\]/.test(name)) continue;
    out.add(name.toLowerCase());
  }
  return out;
}
/** Simple glob matcher: `*` within a segment, `**` across segments, trailing `/` = directory. */
export function toMatcher(pattern: string): (path: string) => boolean {
  const dirOnly = pattern.endsWith("/");
  const cleaned = dirOnly ? pattern.slice(0, -1) : pattern;
  const regex = new RegExp("^" + globToRegex(cleaned) + (dirOnly ? "(?:/.*)?$" : "$"));
  return (path: string) => regex.test(path);
}

function globToRegex(glob: string): string {
  let out = "";
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i]!;
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        i += 1;
        if (glob[i + 1] === "/") {
          i += 1;
          out += "(?:.*/)?";
        } else {
          out += ".*";
        }
      } else {
        out += "[^/]*";
      }
      continue;
    }
    if (ch === "?") {
      out += "[^/]";
      continue;
    }
    if ("\\^$.|+()[]{}".includes(ch)) {
      out += "\\" + ch;
      continue;
    }
    out += ch;
  }
  return out;
}

function toPosix(path: string): string {
  return path.split(sep).join("/").split("\\").join("/");
}

/** First non-empty line of git's stderr, for a one-line warning. */
function firstLine(text: string): string {
  for (const line of text.split(/\r?\n/)) if (line.trim() !== "") return line.trim();
  return "no output";
}

/**
 * Every file the main walk would be allowed to ship, without reading or
 * stating any of them.
 *
 * The import closure needs to know what exists before the real walk runs, and
 * it must agree with the walk about which directories are off limits — a
 * closure that sees `node_modules` would pull the whole dependency tree into
 * the bundle it is supposed to shrink.
 */
async function listWalkable(
  root: string,
  skipDir: (name: string) => boolean,
  excludeGlobs: readonly ((path: string) => boolean)[],
  skipGenerated: string | null,
): Promise<Set<string>> {
  const out = new Set<string>();
  const visit = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const absolute = join(dir, entry.name);
      const rel = toPosix(relative(root, absolute));
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (skipDir(entry.name)) continue;
        if (skipGenerated !== null && (rel === skipGenerated || rel.startsWith(skipGenerated + "/"))) continue;
        if (excludeGlobs.some((match) => match(rel))) continue;
        await visit(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      if (excludeGlobs.some((match) => match(rel))) continue;
      out.add(rel);
    }
  };
  await visit(root);
  return out;
}

/**
 * Map a path printed by a runtime (absolute file URL, Windows path, or a bare
 * relative path) onto a scan-root-relative POSIX path.
 *
 * Unresolvable input is returned as-is rather than dropped: a stack frame that
 * cannot be normalised still names a file the user may want in the bundle, and
 * the include glob is free to match it.
 */
function normalizeToRoot(root: string): (raw: string) => string {
  return (raw: string) => {
    const normalized = raw.split("\\").join("/");
    if (normalized.startsWith(toPosix(root) + "/")) return toPosix(relative(root, normalized));
    if (!normalized.startsWith("/") && !/^[A-Za-z]:/.test(normalized)) return normalized.replace(/^\.\//, "");
    try {
      const absolute = resolve(normalized.startsWith("/") && /^\/[A-Za-z]:/.test(normalized) ? normalized.slice(1) : normalized);
      const mapped = toPosix(relative(root, absolute));
      // A frame outside the scan root is not a file this bundle can carry;
      // keeping the original string lets the caller see it and drop it.
      return mapped.startsWith("..") || isAbsolute(mapped) ? normalized : mapped;
    } catch {
      return normalized;
    }
  };
}
