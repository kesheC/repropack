import { canonicalJson, sha256 } from "../util/hash.js";
import type { Bundle } from "../types.js";

/**
 * The manifest's own integrity field cannot be part of what it hashes, so we
 * hash the payload with `integrity` removed and compare on read.
 */
export function computeIntegrity(bundle: Omit<Bundle, "integrity"> | Bundle): string {
  const { integrity: _ignored, ...payload } = bundle as Bundle;
  return sha256(canonicalJson(payload));
}

export interface ManifestCheck {
  ok: boolean;
  expected: string;
  actual: string;
}

export function checkIntegrity(bundle: Bundle): ManifestCheck {
  const actual = computeIntegrity(bundle);
  return { ok: actual === bundle.integrity, expected: bundle.integrity, actual };
}

/**
 * Validate structure before trusting any field.
 *
 * Bundles travel between machines, so everything here is treated as untrusted
 * input: a manifest claiming `formatVersion: 1` can still have a missing argv
 * or a files entry that points outside the bundle.
 */
export function parseManifest(raw: unknown): { bundle: Bundle; problems: string[] } {
  const problems: string[] = [];
  const obj = raw as Record<string, unknown> | null;
  if (!obj || typeof obj !== "object") {
    return { bundle: null as unknown as Bundle, problems: ["manifest is not an object"] };
  }
  if (obj.formatVersion !== 1) problems.push("unsupported formatVersion: " + String(obj.formatVersion));

  const command = obj.command as Record<string, unknown> | undefined;
  if (!command) problems.push("missing command");
  else {
    if (!Array.isArray(command.argv) || command.argv.length === 0) problems.push("command.argv must be a non-empty array");
    if (typeof command.exitCode !== "number" && command.exitCode !== null) problems.push("command.exitCode must be a number or null");
  }

  const files = obj.files;
  if (!Array.isArray(files)) problems.push("files must be an array");
  else {
    for (const entry of files as Record<string, unknown>[]) {
      if (typeof entry?.path !== "string") {
        problems.push("files entry without a path");
        continue;
      }
      if (isUnsafeRelativePath(entry.path)) problems.push("unsafe file path: " + entry.path);
      if (typeof entry.sha256 !== "string") problems.push("files entry without sha256: " + entry.path);
    }
  }

  for (const key of ["id", "createdAt", "integrity"] as const) {
    if (typeof obj[key] !== "string") problems.push("missing string field: " + key);
  }
  if (!Array.isArray(obj.warnings)) problems.push("warnings must be an array");

  return { bundle: obj as unknown as Bundle, problems };
}

/**
 * Reject paths that would escape the bundle when joined.
 *
 * `files/` entries come from a manifest we did not necessarily write, so a
 * path like `../../.ssh/id_rsa` must never reach the filesystem layer.
 */
export function isUnsafeRelativePath(path: string): boolean {
  if (path.length === 0) return true;
  if (path.startsWith("/") || path.startsWith("\\")) return true;
  if (/^[A-Za-z]:/.test(path)) return true;
  const segments = path.split(/[\\/]+/);
  return segments.some((segment) => segment === ".." || segment === "");
}
