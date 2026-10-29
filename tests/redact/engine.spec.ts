import { describe, expect, it } from "vitest";
import { redactText, mergeReports, collectEnvLiterals, findResidualSecrets } from "../../src/redact/index.js";

/**
 * These tests build fake secrets by concatenation on purpose.
 *
 * A literal `ghp_` + 36 chars in a source file trips GitHub's push protection
 * and refuses the push outright (GH013). Assembling the value at runtime keeps
 * the test meaningful without shipping a string that looks like a live token.
 */
const fake = {
  github: "ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8",
  awsId: "AKIA" + "IOSFODNN7EXAMPLE",
  openai: "sk-" + "proj-" + "a".repeat(32),
  anthropic: "sk-ant-" + "api03-" + "b".repeat(24),
  slack: "xoxb-" + "123456789012-1234567890123-" + "c".repeat(20),
  npm: "npm_" + "d".repeat(36),
};

describe("redactText", () => {
  it("leaves clean text untouched and reports zero matches", () => {
    const input = "const answer = 42;\nconsole.log(answer);";
    const result = redactText(input, { surface: "files/a.ts" });
    expect(result.text).toBe(input);
    expect(result.report.totalMatches).toBe(0);
    expect(result.report.byRule).toHaveLength(0);
  });

  it("replaces a github token and never echoes it in the report", () => {
    const result = redactText("token: " + fake.github, { surface: "files/a.ts" });
    expect(result.text).not.toContain(fake.github);
    expect(result.text).toContain("REDACTED_GITHUB_TOKEN");
    const hit = result.report.byRule.find((r) => r.rule === "github-token");
    expect(hit?.count).toBe(1);
    // The whole point: the report itself is safe to attach to an issue.
    expect(JSON.stringify(result.report)).not.toContain(fake.github);
  });

  it("replaces aws, openai, anthropic, slack and npm shapes", () => {
    const input = [fake.awsId, fake.openai, fake.anthropic, fake.slack, fake.npm].join("\n");
    const result = redactText(input, { surface: "env" });
    for (const secret of Object.values(fake)) {
      expect(result.text).not.toContain(secret);
    }
    expect(result.report.totalMatches).toBeGreaterThanOrEqual(5);
  });

  it("strips credentials out of a URL but keeps the host", () => {
    const result = redactText("remote: https://user:hunter2@github.com/o/r.git", { surface: "files/.git/config" });
    expect(result.text).not.toContain("hunter2");
    expect(result.text).toContain("github.com");
  });

  it("replaces only the value of an assignment, keeping the variable name", () => {
    const result = redactText("DATABASE_PASSWORD = sup3rs3cretvalue\n", { surface: "files/.env" });
    expect(result.text).toContain("DATABASE_PASSWORD");
    expect(result.text).not.toContain("sup3rs3cretvalue");
  });

  it("redacts a PEM private key body", () => {
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA1234567890abcdef\n-----END RSA PRIVATE KEY-----";
    const result = redactText(pem, { surface: "files/id_rsa" });
    expect(result.text).toContain("REDACTED_PRIVATE_KEY_BLOCK");
    expect(result.text).not.toContain("MIIEowIBAAKCAQEA");
  });

  it("is idempotent: redacting twice changes nothing further", () => {
    const once = redactText("key=" + fake.openai, { surface: "s" }).text;
    const twice = redactText(once, { surface: "s" }).text;
    expect(twice).toBe(once);
  });

  it("does not re-match inside placeholders produced by an earlier rule", () => {
    // ASSIGNED_SECRET would happily match "REDACTED_X = y"; the span renderer
    // must produce a single placeholder, not a nested one.
    const result = redactText("api_key = " + fake.openai, { surface: "s" });
    expect(result.text.match(/REDACTED/g)?.length).toBe(1);
  });

  it("replaces env literals that no regex could match", () => {
    const literals = [{ value: "zzz-unique-value-42", rule: "env-value-my-secret" }];
    const result = redactText("value is zzz-unique-value-42 here", { surface: "logs/stdout.txt", literals });
    expect(result.text).toBe("value is REDACTED_ENV_VALUE_MY_SECRET here");
  });

  it("redacts the user name out of a windows home path", () => {
    const result = redactText("open C:\\Users\\alice\\project\\a.ts", { surface: "logs/stderr.txt" });
    expect(result.text).not.toContain("alice");
    expect(result.text).toContain("Users");
  });

  it("keeps byte offsets consistent when several rules fire in one string", () => {
    const input = "a " + fake.github + " b " + fake.openai + " c";
    const result = redactText(input, { surface: "s" });
    expect(result.text.startsWith("a REDACTED_")).toBe(true);
    expect(result.text).toContain(" c");
  });
});

describe("mergeReports", () => {
  it("sums rule counts across surfaces and sorts them", () => {
    const a = redactText(fake.github, { surface: "files/a.ts" });
    const b = redactText(fake.github + " " + fake.github, { surface: "files/b.ts" });
    const merged = mergeReports([a, b]);
    const hit = merged.byRule.find((r) => r.rule === "github-token");
    expect(hit?.count).toBe(3);
    expect(merged.totalMatches).toBe(3);
    expect(merged.bySurface.map((s) => s.surface)).toEqual(["files/a.ts", "files/b.ts"]);
  });

  it("returns an empty report for no inputs", () => {
    const merged = mergeReports([]);
    expect(merged.totalMatches).toBe(0);
    expect(merged.byRule).toEqual([]);
  });
});

describe("collectEnvLiterals", () => {
  it("collects values of secret-looking names only", () => {
    const literals = collectEnvLiterals(
      { MY_SECRET: "abcdefgh", GITHUB_TOKEN: "ghx123456", PLAIN_VAR: "visible", SHORT: "ab" },
      [],
    );
    const values = literals.map((l) => l.value);
    expect(values).toContain("abcdefgh");
    expect(values).toContain("ghx123456");
    expect(values).not.toContain("visible");
    // Too short to be a meaningful secret; skipping avoids mangling common words.
    expect(values).not.toContain("ab");
  });

  it("skips names the operator explicitly allowlisted", () => {
    const literals = collectEnvLiterals({ MY_TOKEN: "abcdefgh" }, ["MY_TOKEN"]);
    expect(literals).toEqual([]);
  });
});

describe("findResidualSecrets", () => {
  it("finds nothing in clean text", () => {
    expect(findResidualSecrets("nothing to see")).toEqual([]);
  });

  it("finds a secret that survived redaction", () => {
    const found = findResidualSecrets("still here: " + fake.openai);
    expect(found.map((f) => f.rule)).toContain("openai-key");
  });
});
