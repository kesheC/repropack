import { formatBytes } from "../util/bytes.js";
import type { Bundle, VerifyResult, VerifyFinding } from "../types.js";

/** Render a bundle summary as human text (stderr/stdout for the `inspect` command). */
export function formatBundle(bundle: Bundle): string {
  const lines: string[] = [];
  const push = (label: string, value: string): void => {
    lines.push("  " + label.padEnd(14) + value);
  };

  lines.push("repropack bundle " + bundle.id.slice(0, 12));
  push("created", bundle.createdAt);
  push("command", shellish(bundle.command.argv));
  push("exit", bundle.command.exitCode === null ? "signal " + String(bundle.command.signal) : String(bundle.command.exitCode));
  push("duration", bundle.command.durationMs + "ms");
  push("node", bundle.environment.node + " (" + bundle.environment.platform + "/" + bundle.environment.arch + ")");

  if (bundle.repository) {
    push("repo", bundle.repository.commit.slice(0, 10) + (bundle.repository.dirty ? " (dirty)" : "") + " on " + (bundle.repository.branch ?? "detached"));
  } else {
    push("repo", "none");
  }

  const bytes = bundle.files.reduce((sum, file) => sum + file.bytes, 0);
  push("files", bundle.files.length + " (" + formatBytes(bytes) + ")");
  push("redacted", bundle.redaction.totalMatches + " match(es) in " + bundle.redaction.byRule.length + " rule(s)");

  if (bundle.warnings.length > 0) {
    lines.push("");
    lines.push("warnings:");
    for (const warning of bundle.warnings) lines.push("  - " + warning);
  }
  return lines.join("\n");
}

/** Render verification findings; returns an empty string when nothing was found. */
export function formatVerify(result: VerifyResult): string {
  if (result.findings.length === 0) return "no findings";
  const lines: string[] = [];
  for (const finding of sortFindings(result.findings)) {
    lines.push("  " + finding.severity.padEnd(8) + finding.code.padEnd(26) + (finding.path ?? "") + ": " + finding.message);
  }
  return lines.join("\n");
}

export function sortFindings(findings: readonly VerifyFinding[]): VerifyFinding[] {
  const rank: Record<VerifyFinding["severity"], number> = { blocker: 0, warning: 1, note: 2 };
  return [...findings].sort(
    (a, b) =>
      rank[a.severity] - rank[b.severity] ||
      (a.code < b.code ? -1 : a.code > b.code ? 1 : 0) ||
      (a.path ?? "").localeCompare(b.path ?? ""),
  );
}

/** Quote argv only where a shell would need it; this is for display, not execution. */
export function shellish(argv: readonly string[]): string {
  return argv
    .map((part) => (/[\s"'$&|;<>()*?]/.test(part) ? JSON.stringify(part) : part))
    .join(" ");
}
