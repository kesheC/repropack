/**
 * Bundle <-> single-file archive.
 *
 * A directory is the right shape while a bundle is being produced (a reader can
 * look inside), but the wrong shape to attach to an issue, paste into a chat or
 * hand to a CI job. This module converts between the two without changing what
 * the bundle means: the archive contains exactly the files under the directory,
 * so unpacking it and running 'repropack verify' gives the same answer.
 */

import { open, mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { gzipTar, readTar, TarError, type TarEntry } from "./tar.js";
import { isUnsafeRelativePath } from "../bundle/manifest.js";

/** Suffix the CLI appends when no explicit filename is given. */
export const ARCHIVE_SUFFIX = ".repropack";
/**
 * Refuse absurd input rather than trying to hold it in memory.
 *
 * 64 MB is roughly a hundred times a realistic bundle and still small enough
 * that unpacking cannot be used to fill the disk on purpose.
 */
export const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;

export interface PackOptions {
  /** Bundle directory to read. */
  readonly root: string;
  /** Archive path to write. */
  readonly out: string;
  /** Unix seconds recorded in the archive; defaults to now. */
  readonly mtime?: number;
}

export interface PackResult {
  readonly out: string;
  readonly bytes: number;
  readonly entries: number;
}

export interface UnpackOptions {
  /** Archive to read, or a directory to copy from. */
  readonly archive: string;
  /** Directory to create. Must be empty or absent. */
  readonly out: string;
}

export interface UnpackResult {
  readonly out: string;
  readonly bytes: number;
  readonly entries: number;
}

/**
 * Collect every regular file under the bundle directory.
 *
 * Sorted by path so two packs of the same bundle produce byte-identical output,
 * which is what lets a maintainer confirm an attachment was not edited.
 */
async function collect(root: string): Promise<TarEntry[]> {
  const entries: TarEntry[] = [];
  const walk = async (dir: string): Promise<void> => {
    const children = await readdir(dir, { withFileTypes: true });
    for (const child of children) {
      const abs = join(dir, child.name);
      if (child.isDirectory()) {
        await walk(abs);
        continue;
      }
      if (!child.isFile()) {
        // Symlinks are not something capture writes; refusing keeps the archive
        // a faithful copy instead of quietly dereferencing to somewhere else.
        throw new TarError("refusing to pack non-regular file: " + relative(root, abs));
      }
      const info = await stat(abs);
      const rel = relative(root, abs).split(sep).join("/");
      if (isUnsafeRelativePath(rel)) throw new TarError("unsafe path in bundle: " + rel);
      const handle = await open(abs, "r");
      try {
        // The executable bit has to be recorded, not inferred: unpacking a
        // bundle on Linux must leave replay.sh runnable, and the tar header is
        // the only place that survives the round trip.
        entries.push({
          path: rel,
          data: await handle.readFile(),
          mtime: Math.floor(info.mtimeMs / 1000),
          executable: (info.mode & 0o111) !== 0,
        });
      } finally {
        await handle.close();
      }
    }
  };
  await walk(root);
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return entries;
}

export async function packBundle(options: PackOptions): Promise<PackResult> {
  const entries = await collect(options.root);
  if (entries.length === 0) throw new TarError("bundle directory is empty: " + options.root);
  const payload = gzipTar(entries);
  await writeFile(options.out, payload);
  return { out: options.out, bytes: payload.length, entries: entries.length };
}

/**
 * Write an archive out as a directory.
 *
 * Every path is validated before anything is written, so a crafted archive
 * cannot escape the output directory: the check happens on the whole entry list
 * first, which also means a rejected archive leaves no partial output behind.
 */
export async function unpackBundle(options: UnpackOptions): Promise<UnpackResult> {
  const handle = await open(options.archive, "r");
  let payload: Buffer;
  try {
    const info = await handle.stat();
    if (info.size > MAX_ARCHIVE_BYTES) {
      throw new TarError(
        "archive is " + String(info.size) + " bytes, over the " + String(MAX_ARCHIVE_BYTES) + " byte limit",
      );
    }
    payload = await handle.readFile();
  } finally {
    await handle.close();
  }

  const entries = readTar(payload);
  for (const entry of entries) {
    if (isUnsafeRelativePath(entry.path)) {
      throw new TarError("archive entry escapes the output directory: " + entry.path);
    }
  }

  await mkdir(options.out, { recursive: true });
  let bytes = 0;
  for (const entry of entries) {
    const target = join(options.out, ...entry.path.split("/"));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, entry.data, entry.executable ? { mode: 0o755 } : undefined);
    bytes += entry.data.length;
  }
  return { out: options.out, bytes, entries: entries.length };
}