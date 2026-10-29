import { createHash } from "node:crypto";
import type {
  RedactionReport,
  RuleHit,
  SkippedFinding,
  SurfaceHit,
  ReplacementStyle,
} from "../types.js";
import { REDACTION_RULES, RULES_VERSION } from "./rules.js";

/**
 * One replacement decided for one span.
 *
 * Spans carry absolute offsets into the source so the renderer can rebuild the
 * text in a single pass; nothing here mutates the input.
 */
interface Span {
  start: number;
  end: number;
  ruleId: string;
  replacement: string;
  /** Placeholder form shown in reports; never the original text. */
  example: string;
}

export interface RedactionResult {
  text: string;
  report: RedactionReport;
  /** rule id -> number of replacements applied to this surface. */
  counts: Map<string, number>;
}

export interface RedactSurfaceOptions {
  /** Name used in `redaction.bySurface`, e.g. "files/src/app.ts". */
  surface: string;
  /**
   * Extra literals that must be replaced verbatim. Used for values read from
   * the environment at capture time: the value itself is known, so no regex
   * could ever be written for it.
   */
  literals?: readonly { value: string; rule: string }[];
}

const PLACEHOLDER_PREFIX = "REDACTED_";

/**
 * Redact one piece of text (a file body or a captured log).
 *
 * Algorithm: collect candidate spans from every rule, drop overlaps keeping the
 * earliest and longest, then rebuild in one pass. We deliberately do not run
 * `String.replace` repeatedly: each pass would see placeholders produced by the
 * previous one and could re-match inside them.
 */
export function redactText(input: string, options: RedactSurfaceOptions): RedactionResult {
  const spans: Span[] = [];
  const skipped: SkippedFinding[] = [];
  const counts = new Map<string, number>();

  if (options.literals) {
    for (const literal of options.literals) {
      if (!literal.value) continue;
      const placeholder = PLACEHOLDER_PREFIX + placeholderName(literal.rule);
      let from = 0;
      for (;;) {
        const at = input.indexOf(literal.value, from);
        if (at < 0) break;
        spans.push({
          start: at,
          end: at + literal.value.length,
          ruleId: literal.rule,
          replacement: placeholder,
          example: placeholder,
        });
        from = at + literal.value.length;
      }
    }
  }

  for (const rule of REDACTION_RULES) {
    // The `d` flag gives per-group offsets, so a rule that targets one capture
    // group replaces exactly that group and leaves its label intact.
    const regex = new RegExp(rule.pattern.source, rule.pattern.flags + "d");
    for (const match of input.matchAll(regex)) {
      const indices = match.indices;
      if (!indices) continue;
      const groupIndex = rule.group ?? 0;
      const range = indices[groupIndex];
      if (!range) continue;
      const [start, end] = range;
      if (end <= start) continue;

      if (!rule.replace) {
        skipped.push({
          rule: rule.id,
          count: 1,
          reason: "shape is suspicious but not certifiably secret",
        });
        continue;
      }
      const text = input.slice(start, end);
      const placeholder = placeholderFor(rule.style, text, rule.id);
      spans.push({ start, end, ruleId: rule.id, replacement: placeholder, example: placeholder });
    }
  }

  const kept = dropOverlaps(spans);
  const text = render(input, kept);
  const byRule = new Map<string, RuleHit>();
  const bySurface = new Map<string, SurfaceHit>();

  for (const span of kept) {
    counts.set(span.ruleId, (counts.get(span.ruleId) ?? 0) + 1);
    const existing = byRule.get(span.ruleId);
    if (existing) byRule.set(span.ruleId, { ...existing, count: existing.count + 1 });
    else byRule.set(span.ruleId, { rule: span.ruleId, count: 1, example: span.example });
    const surface = bySurface.get(options.surface);
    if (surface) bySurface.set(options.surface, { ...surface, count: surface.count + 1 });
    else bySurface.set(options.surface, { surface: options.surface, count: 1 });
  }

  return {
    text,
    counts,
    report: {
      rulesVersion: RULES_VERSION,
      totalMatches: kept.length,
      byRule: sortByRule([...byRule.values()]),
      bySurface: [...bySurface.values()].sort((a, b) => (a.surface < b.surface ? -1 : 1)),
      skipped,
    },
  };
}

/** Merge per-file reports into one bundle-level report. */
export function mergeReports(results: readonly RedactionResult[]): RedactionReport {
  const byRule = new Map<string, RuleHit>();
  const bySurface = new Map<string, SurfaceHit>();
  const skipped = new Map<string, SkippedFinding>();
  let total = 0;

  for (const result of results) {
    total += result.report.totalMatches;
    for (const hit of result.report.byRule) {
      const existing = byRule.get(hit.rule);
      if (existing) byRule.set(hit.rule, { ...existing, count: existing.count + hit.count });
      else byRule.set(hit.rule, { ...hit });
    }
    for (const hit of result.report.bySurface) {
      const existing = bySurface.get(hit.surface);
      if (existing) bySurface.set(hit.surface, { ...existing, count: existing.count + hit.count });
      else bySurface.set(hit.surface, { ...hit });
    }
    for (const finding of result.report.skipped) {
      const key = finding.rule + "\u0000" + finding.reason;
      const existing = skipped.get(key);
      if (existing) skipped.set(key, { ...existing, count: existing.count + finding.count });
      else skipped.set(key, { ...finding });
    }
  }

  return {
    rulesVersion: RULES_VERSION,
    totalMatches: total,
    byRule: sortByRule([...byRule.values()]),
    bySurface: [...bySurface.values()].sort((a, b) => (a.surface < b.surface ? -1 : 1)),
    skipped: [...skipped.values()].sort((a, b) => (a.rule < b.rule ? -1 : 1)),
  };
}

/** Rule ids that actually replaced something, for `verify` summaries. */
export function firedRules(report: RedactionReport): readonly string[] {
  return report.byRule.filter((r) => r.count > 0).map((r) => r.rule);
}

/**
 * True when a string is one of our own placeholders.
 *
 * Re-scanning redacted text needs this: `user-home-path` turns
 * `C:\Users\alice\...` into `C:\Users\REDACTED_USER_HOME_PATH\...`, which
 * trips the very same rule again. Counting that as a residual secret would make
 * every bundle captured from a home directory unverifiable.
 */
export function isPlaceholderText(value: string): boolean {
  return value.startsWith(PLACEHOLDER_PREFIX);
}

/**
 * Re-scan already-redacted text. Anything that still trips a rule means
 * redaction missed a span, so `verify` turns this into a blocker.
 *
 * Placeholders are excluded by checking the *captured* text rather than the
 * whole match, so a rule that rewrites one group inside a larger shape does not
 * report itself.
 */
export function findResidualSecrets(text: string): readonly { rule: string; count: number }[] {
  const hits = new Map<string, number>();
  for (const rule of REDACTION_RULES) {
    if (!rule.replace) continue;
    const regex = new RegExp(rule.pattern.source, rule.pattern.flags + "d");
    let count = 0;
    for (const match of text.matchAll(regex)) {
      const range = match.indices?.[rule.group ?? 0];
      if (!range) continue;
      if (isPlaceholderText(text.slice(range[0], range[1]))) continue;
      // A match that swallows one of our own placeholders is an artifact of the
      // previous pass, not a fresh leak. Without this, redacting a URL userinfo
      // leaves "REDACTED_URL_CREDENTIALS@host", and the assignment rule happily
      // reads that as a secret named ...CREDENTIALS with the host as its value.
      if (match[0].includes(PLACEHOLDER_PREFIX)) continue;
      count += 1;
    }
    if (count > 0) hits.set(rule.id, count);
  }
  return [...hits.entries()].map(([rule, count]) => ({ rule, count }));
}

/** Literals gathered from the environment that must never reach a bundle. */
export function collectEnvLiterals(
  env: Readonly<Record<string, string>>,
  allowlist: readonly string[],
): readonly { value: string; rule: string }[] {
  const allowed = new Set(allowlist.map((name) => name.toUpperCase()));
  const out: { value: string; rule: string }[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (allowed.has(name.toUpperCase())) continue;
    if (!looksSensitiveName(name)) continue;
    if (value.length < 6) continue;
    out.push({ value, rule: "env-value-" + name.toLowerCase().replace(/[^a-z0-9]+/g, "-") });
  }
  return out;
}

function looksSensitiveName(name: string): boolean {
  return /(secret|token|passw|password|credential|api[_-]?key|apikey|auth|private|session|cookie|dsn)/i.test(name);
}

/* ------------------------------------------------------------------ */

function dropOverlaps(spans: readonly Span[]): Span[] {
  if (spans.length <= 1) return [...spans];
  const sorted = [...spans].sort((a, b) => a.start - b.start || b.end - b.start - (a.end - a.start));
  const kept: Span[] = [];
  let cursor = 0;
  for (const span of sorted) {
    if (span.start < cursor) continue;
    kept.push(span);
    cursor = span.end;
  }
  return kept;
}

function render(input: string, spans: readonly Span[]): string {
  if (spans.length === 0) return input;
  const out: string[] = [];
  let cursor = 0;
  for (const span of spans) {
    out.push(input.slice(cursor, span.start));
    out.push(span.replacement);
    cursor = span.end;
  }
  out.push(input.slice(cursor));
  return out.join("");
}

function placeholderName(ruleId: string): string {
  return ruleId.replace(/[^A-Za-z0-9]+/g, "_").toUpperCase();
}

function placeholderFor(style: ReplacementStyle, text: string, ruleId: string): string {
  const name = PLACEHOLDER_PREFIX + placeholderName(ruleId);
  switch (style) {
    case "placeholder":
      return name;
    case "hash":
      return name + "_" + createHash("sha256").update(text, "utf8").digest("hex").slice(0, 8);
    case "length":
      return name + "_" + String(text.length);
  }
}

function sortByRule(hits: readonly RuleHit[]): RuleHit[] {
  return [...hits].sort((a, b) => (a.rule < b.rule ? -1 : a.rule > b.rule ? 1 : 0));
}
