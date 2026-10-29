import { createHash } from "node:crypto";

/** sha256 of a string, hex encoded. */
export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** sha256 of raw bytes, hex encoded. */
export function sha256Bytes(buf: Buffer | Uint8Array): string {
  return createHash("sha256").update(buf).digest("hex");
}

/**
 * Stable JSON: object keys sorted at every depth, `undefined` dropped.
 *
 * Hashing anything that goes through this is reproducible across processes and
 * across Node versions, which plain `JSON.stringify` is not (key order follows
 * insertion order).
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value === null || typeof value !== "object") return value;
  const src = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(src).sort()) {
    const v = src[key];
    if (v === undefined) continue;
    out[key] = sortDeep(v);
  }
  return out;
}

/**
 * Content id for a bundle. Excludes fields that legitimately differ between
 * two captures of the same failure (the id itself, timestamps, and measured
 * durations), otherwise the same repro would hash differently every run.
 */
export function bundleId(payload: {
  command: { argv: readonly string[]; exitCode: number | null };
  environment: unknown;
  repository: unknown;
  files: readonly { path: string; sha256: string }[];
}): string {
  return sha256(
    canonicalJson({
      argv: payload.command.argv,
      exitCode: payload.command.exitCode,
      environment: payload.environment,
      repository: payload.repository,
      files: payload.files
        .map((f) => ({ path: f.path, sha256: f.sha256 }))
        .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    }),
  );
}
