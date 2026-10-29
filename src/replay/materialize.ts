import { mkdir, writeFile, chmod } from "node:fs/promises";
import { dirname, join, relative, isAbsolute } from "node:path";
import { readBundle, type LoadedBundle } from "../bundle/read.js";
import { sha256Bytes } from "../util/hash.js";
import type { ReplayReason } from "../types.js";

export interface MaterializeResult {
  root: string;
  /** Files written, in manifest order. */
  written: readonly string[];
  reasons: readonly ReplayReason[];
}

/**
 * Write a bundle's files into a fresh working directory.
 *
 * Every file is hashed as it is written, not just counted: a bundle that was
 * corrupted in transit must fail loudly here rather than produce a confusing
 * "test still passes" result during replay.
 */
export async function materialize(loaded: LoadedBundle, target: string): Promise<MaterializeResult> {
  const reasons: ReplayReason[] = [];
  const written: string[] = [];

  for (const entry of loaded.manifest.files) {
    const source = join(loaded.root, "files", entry.path);
    const destination = join(target, entry.path);

    // Defence in depth: `parseManifest` already rejected these, but a bundle can
    // be hand-edited between read and write.
    const rel = relative(target, destination);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      reasons.push({ kind: "missing-file", path: entry.path });
      continue;
    }

    let content: Buffer;
    try {
      content = await readFileOrThrow(source);
    } catch {
      reasons.push({ kind: "missing-file", path: entry.path });
      continue;
    }

    const actual = sha256Bytes(content);
    if (actual !== entry.sha256) {
      reasons.push({ kind: "hash-mismatch", path: entry.path, expected: entry.sha256, actual });
      continue;
    }

    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, content);
    if (entry.mode === "100755" && process.platform !== "win32") {
      await chmod(destination, 0o755);
    }
    written.push(entry.path);
  }

  return { root: target, written, reasons };
}

async function readFileOrThrow(path: string): Promise<Buffer> {
  const { readFile } = await import("node:fs/promises");
  return readFile(path);
}

export { readBundle };
