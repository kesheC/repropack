import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { sha256Bytes, bundleId } from "../util/hash.js";
import { computeIntegrity, isUnsafeRelativePath } from "./manifest.js";
import type { Bundle, BundleFile } from "../types.js";

export interface StagedFile {
  /** POSIX path relative to the bundle root, e.g. "files/src/app.ts". */
  path: string;
  content: Buffer;
  mode: "100644" | "100755";
  reason: BundleFile["reason"];
  truncated: boolean;
  /** Path as it appeared in the source worktree, used for the manifest entry. */
  sourcePath: string;
}

export interface WriteBundleInput {
  root: string;
  manifest: Omit<Bundle, "files" | "integrity" | "id">;
  files: readonly StagedFile[];
  logs: readonly { path: string; content: Buffer }[];
}

export interface WriteBundleResult {
  manifest: Bundle;
  manifestPath: string;
  totalBytes: number;
}

/**
 * Materialise a bundle directory.
 *
 * Order matters: payload files and logs first, then the manifest. If the
 * process dies partway through, the directory has no manifest and every reader
 * treats it as incomplete rather than as a valid bundle with missing files.
 *
 * The id is derived from content (argv, exit code, environment, repository and
 * file hashes) so two captures of the same failure produce the same id even
 * though their timestamps and durations differ.
 */
export async function writeBundle(input: WriteBundleInput): Promise<WriteBundleResult> {
  let totalBytes = 0;
  const entries: BundleFile[] = [];

  for (const file of input.files) {
    // A caller (or a corrupted scan result) must never be able to write outside
    // the bundle root: `files/../../x` would silently land next to it.
    if (isUnsafeRelativePath(file.path)) {
      throw new Error("unsafe bundle path: " + file.path);
    }
    const target = join(input.root, file.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.content);
    totalBytes += file.content.byteLength;
    entries.push({
      path: file.sourcePath,
      bytes: file.content.byteLength,
      sha256: sha256Bytes(file.content),
      mode: file.mode,
      reason: file.reason,
      truncated: file.truncated,
    });
  }

  for (const log of input.logs) {
    if (isUnsafeRelativePath(log.path)) {
      throw new Error("unsafe bundle path: " + log.path);
    }
    const target = join(input.root, log.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, log.content);
  }

  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const id = bundleId({
    command: { argv: input.manifest.command.argv, exitCode: input.manifest.command.exitCode },
    environment: input.manifest.environment,
    repository: input.manifest.repository,
    files: entries.map((f) => ({ path: f.path, sha256: f.sha256 })),
  });

  const partial: Omit<Bundle, "integrity"> = {
    ...input.manifest,
    id,
    files: entries,
  };
  const manifest: Bundle = { ...partial, integrity: computeIntegrity(partial) };

  const manifestPath = join(input.root, "bundle.json");
  await mkdir(dirname(manifestPath), { recursive: true });
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");

  return { manifest, manifestPath, totalBytes };
}
