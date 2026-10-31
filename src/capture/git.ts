import { isAbsolute, relative, resolve } from "node:path";
import { runCapture, tryCapture } from "../util/exec.js";
import { redactText } from "../redact/index.js";
import type { RepositorySnapshot } from "../types.js";

const MAX_STATUS_LINES = 200;

/**
 * Describe the git repository containing `cwd`, or return null when there is
 * none.
 *
 * Returning null — rather than throwing — matters because "not a git repo" is a
 * completely normal state for the tool: you can capture a bug in a scratch
 * directory. The caller records that absence in `repository: null`.
 */
export async function probeRepository(cwd: string): Promise<RepositorySnapshot | null> {
  const inRepo = await tryCapture(["git", "rev-parse", "--is-inside-work-tree"], { cwd, timeoutMs: 10_000 });
  if (inRepo !== "true") return null;

  const rootRaw = await tryCapture(["git", "rev-parse", "--show-toplevel"], { cwd, timeoutMs: 10_000 });
  if (!rootRaw) return null;
  const root = resolve(rootRaw);

  const commit = await tryCapture(["git", "rev-parse", "HEAD"], { cwd, timeoutMs: 10_000 });
  const branch = await tryCapture(["git", "rev-parse", "--abbrev-ref", "HEAD"], { cwd, timeoutMs: 10_000 });
  const describe = await tryCapture(["git", "describe", "--tags", "--always", "--dirty"], { cwd, timeoutMs: 10_000 });
  const status = await tryCapture(["git", "status", "--porcelain"], { cwd, timeoutMs: 20_000 });
  const statusLines = (status ?? "")
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
    .slice(0, MAX_STATUS_LINES)
    .map((line) => scrubAbsolutePrefix(line, root, cwd))
    // A branch name or a file name may itself contain a token; types.ts
    // promises these lines are redacted, so run the engine over them.
    .map((line) => redactText(line, { surface: "repository.statusLines" }).text);

  const remotesRaw = await tryCapture(["git", "remote", "-v"], { cwd, timeoutMs: 10_000 });
  // A remote can carry a user name in its path (https://host/alice/repo.git),
  // and a self-hosted origin can carry a token that survived stripCredentials.
  // Both are published with the bundle, so both get the same treatment.
  const remotes = parseRemotes(remotesRaw ?? "").map((remote) => ({
    name: remote.name,
    url: redactText(remote.url, { surface: "repository.remotes" }).text,
  }));

  return {
    vcs: "git",
    // Everything here ends up in bundle.json, which is published verbatim when
    // the bundle is attached to an issue. An absolute root therefore publishes
    // the OS user name of whoever produced it -- which is why this goes through
    // the same redaction engine as the file contents instead of being stored
    // raw. The unredacted `root` stays local: it is only needed below, to strip
    // the prefix off status lines.
    root: redactText(root, { surface: "repository.root" }).text,
    commit: commit ?? "",
    branch: branch && branch !== "HEAD" ? branch : null,
    describe: describe ?? null,
    dirty: statusLines.length > 0,
    statusLines,
    remotes,
  };
}

/**
 * Strip credentials from a remote URL.
 *
 * `git remote -v` prints whatever is configured, which for CI checkouts is
 * frequently `https://x-access-token:<token>@github.com/owner/repo`. Shipping
 * that inside a bundle would leak a working credential into a file people are
 * expected to attach to bug reports, so we rewrite the userinfo away.
 *
 * The whole userinfo goes, including a bare `https://ghp_xxx@host`. A bare word
 * before the `@` is usually a user name, but the two shapes are
 * indistinguishable and guessing wrong ships a live PAT to a bug tracker. A
 * mis-stripped user name costs the reader one re-type; a kept token costs a
 * credential. scp-style (`git@host:path`) is untouched: it has no scheme, so
 * there is no userinfo section to leak.
 */
export function stripCredentials(url: string): string {
  const schemeMatch = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//.exec(url);
  if (!schemeMatch) return url;
  const scheme = schemeMatch[1]!;
  const rest = url.slice(schemeMatch[0].length);
  const at = rest.indexOf("@");
  if (at < 0) return url;
  // An "@" after the first path separator belongs to the path
  // (`https://host/o/r@v1`), not to a userinfo section.
  const authorityEnd = rest.search(/[/?#]/);
  const slashIndex = authorityEnd < 0 ? rest.length : authorityEnd;
  if (at > slashIndex) return url;
  return scheme + "://" + rest.slice(at + 1);
}

function parseRemotes(raw: string): { name: string; url: string }[] {
  const seen = new Map<string, string>();
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const match = /^(\S+)\s+(\S+)\s+\((fetch|push)\)$/.exec(line.trim());
    if (!match) continue;
    const [, name, url] = match;
    if (!name || !url) continue;
    if (!seen.has(name)) seen.set(name, stripCredentials(url));
  }
  return [...seen.entries()].map(([name, url]) => ({ name, url })).sort((a, b) => (a.name < b.name ? -1 : 1));
}

/**
 * Replace the absolute repo prefix in status lines with `.` so the bundle does
 * not hard-code where it was produced.
 */
function scrubAbsolutePrefix(line: string, root: string, cwd: string): string {
  let out = line;
  for (const prefix of [relative(cwd, root), cwd, root]) {
    if (!prefix) continue;
    if (isAbsolute(prefix)) continue;
    out = out.split(prefix + "/").join("").split(prefix + "\\").join("");
  }
  return out;
}

/** Absolute path of the repository root, or null. Exported for reuse by scan. */
export async function findRepoRoot(cwd: string): Promise<string | null> {
  const raw = await tryCapture(["git", "rev-parse", "--show-toplevel"], { cwd, timeoutMs: 10_000 });
  return raw ? resolve(raw) : null;
}
