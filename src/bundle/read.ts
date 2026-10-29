import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { sha256Bytes } from "../util/hash.js";
import { checkIntegrity, parseManifest } from "./manifest.js";
import type { Bundle } from "../types.js";

export interface LoadedBundle {
  root: string;
  manifest: Bundle;
  /** Non-fatal problems; a non-empty list means the bundle is suspect. */
  problems: string[];
  integrityOk: boolean;
}

/**
 * Read `bundle.json` and validate its shape and integrity.
 *
 * Every consumer goes through here so that a corrupt or hostile bundle is
 * rejected in one place. File bodies are *not* read: callers verify only the
 * files they actually need, which keeps `inspect` cheap on a multi-GB bundle.
 */
export async function readBundle(root: string): Promise<LoadedBundle> {
  const raw = await readFile(join(root, "bundle.json"), "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error("bundle.json is not valid JSON: " + (error as Error).message);
  }

  const { bundle, problems } = parseManifest(parsed);
  if (problems.length > 0 && !bundle) {
    throw new Error("invalid bundle: " + problems.join("; "));
  }

  const integrity = checkIntegrity(bundle);
  if (!integrity.ok) {
    problems.push("integrity mismatch: expected " + integrity.expected.slice(0, 12) + "…, got " + integrity.actual.slice(0, 12) + "…");
  }

  return { root, manifest: bundle, problems, integrityOk: integrity.ok };
}

/** Read one file out of the bundle and check it against the manifest hash. */
export async function readBundleFile(
  loaded: LoadedBundle,
  entryPath: string,
): Promise<{ content: Buffer; sha256: string; matches: boolean }> {
  const entry = loaded.manifest.files.find((f) => f.path === entryPath);
  if (!entry) throw new Error("file not in bundle: " + entryPath);
  const content = await readFile(join(loaded.root, "files", entry.path));
  const sha256 = sha256Bytes(content);
  return { content, sha256, matches: sha256 === entry.sha256 };
}
