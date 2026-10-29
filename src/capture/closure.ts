import { readFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

/**
 * Follow relative imports out from the files a stack trace named.
 *
 * A failure points at the line that threw, but that line almost always calls
 * into a sibling module. Capturing only the frame site produces a bundle that
 * dies on `ERR_MODULE_NOT_FOUND` the moment it is replayed — a "reproduction"
 * that appears to work only because the missing-module exit code happens to
 * match the recorded one. Closing over local imports (never over
 * `node_modules`) is what makes a minimal bundle actually reproduce.
 *
 * Deliberately bounded and textual: this is not a resolver, it is a heuristic
 * reading specifiers as they appear in the source. A specifier it cannot see
 * is simply not added, which is the failure mode repropack already had.
 */
export interface ClosureOptions {
  /** Absolute project root; specifiers that resolve outside it are dropped. */
  readonly root: string;
  /** Seed paths, POSIX-relative to `root`. */
  readonly seeds: readonly string[];
  /** Every file the scan walk saw; the closure may only return paths from it. */
  readonly known: ReadonlySet<string>;
  /** Stop after this many files; keeps a pathological graph out of a bundle. */
  readonly limit?: number;
}

const DEFAULT_LIMIT = 400;
const SOURCE_EXTENSIONS = [".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx", ".mts", ".cts"];
const RESOLVE_SUFFIXES = [
  "",
  ".js",
  ".mjs",
  ".cjs",
  ".jsx",
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  "/index.js",
  "/index.ts",
];

// `from "./x"`, `import("./x")`, `require("./x")`, bare `import "./x"` and
// re-exports all reduce to the same question: is this specifier relative?
const SPECIFIER = /(?:from\s*|import\s*\(?\s*|require\s*\(?\s*|export\s*\(?\s*)[\x27"]([^\x27"]+)[\x27"]/g;

/**
 * Breadth-first closure over relative imports, starting at `seeds`.
 *
 * Returns the seeds themselves plus everything reachable from them, so the
 * caller can simply union the result into its selection.
 */
export async function collectLocalImports(options: ClosureOptions): Promise<readonly string[]> {
  const limit = options.limit ?? DEFAULT_LIMIT;
  const root = resolve(options.root);
  const rootPrefix = root.split(sep).join("/");
  const seen = new Set<string>();
  const queue: string[] = [];

  const enqueue = (path: string): void => {
    if (seen.has(path) || seen.size >= limit) return;
    seen.add(path);
    queue.push(path);
  };
  for (const seed of options.seeds) enqueue(seed);

  // Index walks the queue by position instead of shift(): a long closure on a
  // big project would otherwise pay O(n^2) array moves.
  for (let index = 0; index < queue.length && seen.size < limit; index += 1) {
    const current = queue[index] as string;
    if (!isSourceFile(current)) continue;
    let text: string;
    try {
      text = await readFile(join(root, current), "utf8");
    } catch {
      continue;
    }
    for (const match of text.matchAll(SPECIFIER)) {
      const specifier = match[1];
      if (!specifier || !specifier.startsWith(".")) continue;
      const resolved = resolveSpecifier(root, current, specifier, rootPrefix, options.known);
      if (resolved !== null) enqueue(resolved);
    }
  }

  return [...seen];
}

function isSourceFile(path: string): boolean {
  return SOURCE_EXTENSIONS.some((extension) => path.endsWith(extension));
}

/**
 * Turn the specifier written in `from` into a root-relative file that exists.
 *
 * Existence is decided against the walk result (`known`) rather than the
 * filesystem: the walk already enumerated everything it is willing to ship,
 * so anything outside that set — node_modules, ignored directories, files over
 * the size budget — stays out of the bundle by construction.
 */
function resolveSpecifier(
  root: string,
  from: string,
  specifier: string,
  rootPrefix: string,
  known: ReadonlySet<string>,
): string | null {
  const absolute = resolve(join(root, from, "..", specifier)).split(sep).join("/");
  if (absolute !== rootPrefix && !absolute.startsWith(rootPrefix + "/")) return null;
  const withoutRoot = absolute === rootPrefix ? "" : absolute.slice(rootPrefix.length + 1);
  if (withoutRoot === "") return null;
  if (withoutRoot.split("/").includes("..")) return null;

  for (const suffix of RESOLVE_SUFFIXES) {
    const candidate = withoutRoot + suffix;
    if (known.has(candidate)) return candidate;
  }
  return null;
}