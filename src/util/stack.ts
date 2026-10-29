/**
 * Pull file paths out of captured stack traces.
 *
 * A bundle only needs the files the failure actually touched, so the stack is
 * the highest-signal source of "which files matter" we have. We accept the
 * shapes that Node, V8, Python, Go, Java and Rust print, because `repropack`
 * is language agnostic — it runs whatever command you give it.
 */

export interface StackFrameRef {
  /** Path as printed, possibly absolute and possibly with a `file://` prefix. */
  readonly raw: string;
  /** Line number when the format carries one. */
  readonly line: number | null;
  /** Column number when the format carries one. */
  readonly column: number | null;
}

const PATTERNS: readonly RegExp[] = [
  // Node ESM on Windows prints file:///C:/x/y.js:1:2. The generic pattern below
  // cannot match it: after the optional scheme the path starts with "/", and the
  // character class stops at the drive-letter colon, so every frame is dropped
  // and a capture ends up with no source files at all.
  /(?:^|[\s(])file:\/\/\/([A-Za-z]:\/[^\s():]+):(\d+):(\d+)/g,
  // Node / V8: at fn (/abs/path/file.ts:12:34) or at /abs/path/file.ts:12:34
  /(?:^|[\s(])((?:file:\/\/)?(?:[A-Za-z]:[\\/]|\/)[^\s():]+):(\d+):(\d+)/g,
  // Python: File "/abs/path/file.py", line 12
  /File "([^"]+)", line (\d+)/g,
  // Go: /abs/path/file.go:12 +0x1d
  /^\s*((?:[A-Za-z]:[\\/]|\/)[^\s:]+):(\d+)/gm,
  // Java / Kotlin: at pkg.Class(File.java:12)
  /\(([\w.$-]+\.(?:java|kt|scala)):(\d+)\)/g,
];

/**
 * Extract frame references, deduplicated by raw path.
 *
 * The same file usually appears many times in a long stack; keeping every
 * occurrence would just make the caller dedupe again.
 */
export function parseStackFrames(text: string, limit = 200): readonly StackFrameRef[] {
  const seen = new Map<string, StackFrameRef>();
  for (const pattern of PATTERNS) {
    const regex = new RegExp(pattern.source, pattern.flags);
    for (const match of text.matchAll(regex)) {
      const raw = match[1];
      if (!raw) continue;
      const path = stripFileUrl(raw);
      if (seen.has(path)) continue;
      const line = match[2] ? Number.parseInt(match[2], 10) : null;
      const column = match[3] ? Number.parseInt(match[3], 10) : null;
      seen.set(path, { raw: path, line: Number.isNaN(line as number) ? null : line, column: Number.isNaN(column as number) ? null : column });
      if (seen.size >= limit) return [...seen.values()];
    }
  }
  return [...seen.values()];
}

/** Remove the `file://` wrapper Node prints on the import path. */
export function stripFileUrl(raw: string): string {
  if (raw.startsWith("file://")) {
    const withoutScheme = raw.slice("file://".length);
    // file:///C:/x -> /C:/x -> C:/x  (Windows path printed by Node's ESM loader)
    if (/^\/[A-Za-z]:[\\/]/.test(withoutScheme)) return withoutScheme.slice(1);
    return decodeURIComponent(withoutScheme);
  }
  return raw;
}

/**
 * True when the path looks like it belongs to the runtime rather than the
 * user's project (node_modules, site-packages, the JDK, the Rust sysroot).
 * Those files are never worth shipping inside a bundle.
 */
export function isRuntimePath(path: string): boolean {
  return /(?:^|[\\/])(?:node_modules|site-packages|dist-packages|\.cargo|\.rustup|\.nvm|\.pyenv|lib[\\/]python\d|\.dsh|\.cache[\\/])(?:[\\/]|$)/.test(
    path,
  ) || /[\\/]lib[\\/](?:jvm|java|ruby|node_modules)[\\/]/.test(path);
}
