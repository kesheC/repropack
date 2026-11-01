/**
 * Bundle <-> single-file archive.
 *
 * A directory is the right shape while a bundle is being produced (a reader can
 * look inside), but the wrong shape to attach to an issue, paste into a chat or
 * hand to a CI job. This module converts between the two without changing what
 * the bundle means: the archive contains exactly the files the bundle declares,
 * so unpacking it and running 'repropack verify' gives the same answer.
 *
 * "Declares" is the load-bearing word. Copying the whole directory is easier and
 * was what this module did first, but it quietly made the archive a superset of
 * the bundle: a stray .env, an editor swap file, a notes.txt the user dropped
 * next to the logs all got compressed and published, none of them mentioned in
 * bundle.json, none of them scanned by verify. The archive is the artifact that
 * leaves the machine, so it ships a fixed manifest of paths and nothing else.
 */

import { open, mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { gzipTar, readTar, TarError, type TarEntry } from "./tar.js";
import { readBundle } from "../bundle/read.js";
import { isUnsafeRelativePath } from "../bundle/manifest.js";
import type { Bundle } from "../types.js";

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

/** Files the bundle format puts at the root, next to bundle.json. */
const ROOT_FILES: readonly string[] = [
  "bundle.json",
  "Dockerfile",
  "replay.sh",
  "replay.cmd",
  "README.md",
];

/** Logs capture always writes, whether or not the command produced output. */
const LOG_FILES: readonly string[] = ["logs/stdout.txt", "logs/stderr.txt"];

/**
 * The archive's table of contents: the manifest's files plus the fixed extras.
 *
 * Sorted by path so two packs of the same bundle produce byte-identical output,
 * which is what lets a maintainer confirm an attachment was not edited.
 *
 * Anything on disk that is not listed is left out rather than refused. Refusing
 * would make pack fail on a bundle the user can already verify, inspect and
 * replay -- the extra file is harmless there and only becomes a problem at the
 * moment it would be published -- so the fix is to not publish it.
 */
function contentsOf(manifest: Bundle): readonly string[] {
  const paths = new Set<string>(ROOT_FILES);
  for (const file of manifest.files) {
    // The manifest records the surface path (src/app.ts); the bundle keeps it
    // under files/ so a bundle is self-describing when unzipped by hand.
    paths.add("files/" + file.path.split(/[\\/]/).join("/"));
  }
  for (const log of LOG_FILES) paths.add(log);
  return [...paths].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

async function collect(root: string, wanted: readonly string[]): Promise<TarEntry[]> {
  const entries: TarEntry[] = [];
  const queue = [...wanted];
  while (queue.length > 0) {
    const rel = queue.shift();
    if (rel === undefined) break;
    const abs = join(root, rel);
    let info;
    try {
      info = await stat(abs);
    } catch {
      // A declared file that is not on disk is verify's finding (missing-file),
      // not an error here: pack should not add a second, worse message for it.
      continue;
    }
    if (info.isDirectory()) {
      // A declared path that turned out to be a directory contributes its files
      // rather than being skipped, so a manifest listing "files/src" still packs.
      const children = await readdir(abs, { withFileTypes: true });
      for (const child of children) queue.push(rel + "/" + child.name);
      continue;
    }
    if (!info.isFile()) {
      // Symlinks are not something capture writes; refusing keeps the archive
      // a faithful copy instead of quietly dereferencing to somewhere else.
      throw new TarError("refusing to pack non-regular file: " + rel);
    }
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
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return entries;
}


/**
 * Pack a bundle directory into a single archive.
 *
 * The manifest is read first because it is what says which files belong to the
 * bundle; a directory without one is not a bundle, and packing it would produce
 * an archive that looks publishable but cannot be replayed.
 */
export async function packBundle(options: PackOptions): Promise<PackResult> {
  const loaded = await readBundle(options.root);
  const entries = await collect(options.root, contentsOf(loaded.manifest));
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