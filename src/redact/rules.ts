/**
 * Redaction rule table.
 *
 * Rules are ordered by specificity: the first rule that claims a span owns it,
 * and later rules cannot re-match inside a span an earlier rule already
 * replaced. That ordering matters more than the individual regexes — a
 * generic "assignment" rule running before the vendor rules would swallow the
 * prefix and hide the more precise name from the report.
 *
 * Every pattern is written against already-decoded UTF-8 text.
 */

import type { ReplacementStyle } from "../types.js";

export const RULES_VERSION = "1";

export interface RedactionRule {
  /** Stable id, appears verbatim in `redaction.byRule`. */
  readonly id: string;
  /** Human sentence used in reports and docs. */
  readonly description: string;
  readonly pattern: RegExp;
  readonly style: ReplacementStyle;
  /**
   * When false the rule only reports a hit and leaves the surface untouched.
   * Used for shapes that are suspicious but not certifiably secret (a 40-char
   * base64 blob might be an asset hash).
   */
  readonly replace: boolean;
  /** Only replace group N (1-based); 0 or absent means the whole match. */
  readonly group?: number;
}

function rule(
  id: string,
  description: string,
  pattern: RegExp,
  options: { style?: ReplacementStyle; replace?: boolean; group?: number } = {},
): RedactionRule {
  return {
    id,
    description,
    pattern,
    style: options.style ?? "placeholder",
    replace: options.replace ?? true,
    group: options.group,
  };
}

export const REDACTION_RULES: readonly RedactionRule[] = [
  rule(
    "private-key-block",
    "PEM private key body",
    /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----[\s\S]{16,}?-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/g,
  ),
  rule(
    "aws-access-key-id",
    "AWS access key id",
    /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|ABIA|ACCA)[0-9A-Z]{16}\b/g,
  ),
  rule(
    "aws-secret-access-key",
    "AWS secret access key (40 base64 chars next to an AWS-ish name)",
    /\baws_?secret_?access_?key\b\s*(?:[:=]|=>)\s*["']?([A-Za-z0-9/+]{40})["']?/gi,
    { group: 1 },
  ),
  rule("github-token", "GitHub personal access token", /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b/g),
  rule("github-fine-grained-token", "GitHub fine-grained token", /\bgithub_pat_[A-Za-z0-9_]{22,}\b/g),
  rule("openai-key", "OpenAI style secret key", /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{24,}\b/g),
  rule("anthropic-key", "Anthropic API key", /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g),
  rule("stripe-key", "Stripe secret or restricted key", /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g),
  rule("slack-token", "Slack token", /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g),
  rule("google-api-key", "Google API key", /\bAIza[0-9A-Za-z_-]{35}\b/g),
  rule("npm-token", "npm automation token", /\bnpm_[A-Za-z0-9]{36}\b/g),
  rule("pypi-token", "PyPI upload token", /\bpypi-[A-Za-z0-9_-]{50,}\b/g),
  rule("jwt", "JSON Web Token", /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g),
  rule(
    "url-credentials",
    "Credentials embedded in a URL (the userinfo, not the host)",
    // Only the "user:password" half is replaced. Rewriting the whole prefix
    // would delete the scheme and the "@", leaving a string that is no longer a
    // URL — and gluing the placeholder onto the host makes the host look like
    // part of a secret assignment to the rules below.
    /\b[a-z][a-z0-9+.-]*:\/\/([^\s/:@]+:[^\s/@]+)@/gi,
    { group: 1 },
  ),
  rule("db-password", "Password inside a connection string", /\b(?:password|pwd)\s*=\s*[^;&\s"']{3,}/gi),
  rule(
    "authorization-header",
    "Authorization header value",
    /\b(?:authorization|proxy-authorization)\s*:\s*(?:bearer|basic|token|digest)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  ),
  rule(
    "bearer-token",
    "Bare bearer token",
    /\bbearer\s+[A-Za-z0-9._~+/-]{20,}={0,2}/gi,
  ),
  rule(
    "assigned-secret",
    "Secret-ish value assigned to a secret-ish name",
    /\b([A-Za-z0-9_.-]*(?:api[_-]?key|apikey|secret|token|passwd|password|credential|access[_-]?key|auth[_-]?key)[A-Za-z0-9_.-]*)\b\s*[:=]\s*("[^"]{6,}"|'[^']{6,}'|[^\s"',;]{6,})/gi,
    { group: 2 },
  ),
  rule(
    "user-home-path",
    "User name segment of an absolute home path",
    /(?:[A-Za-z]:[\\/]Users[\\/]|\/(?:home|Users)\/)([^\\/\s"']+)/g,
    { group: 1, style: "placeholder" },
  ),
] as const;

/** Rule ids that only ever *report*, never rewrite. */
export const REPORT_ONLY_RULES = new Set(REDACTION_RULES.filter((r) => !r.replace).map((r) => r.id));
