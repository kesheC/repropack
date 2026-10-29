import { describe, expect, it } from "vitest";
import { redactText, findResidualSecrets } from "../../src/redact/index.js";

describe("url-credentials keeps the URL readable", () => {
  it("replaces only the userinfo, leaving scheme and host intact", () => {
    const result = redactText("DATABASE_URL=postgres://demo:hunter2@localhost:5432/demo", {
      surface: "files/.env.example",
    });
    expect(result.text).toBe("DATABASE_URL=postgres://REDACTED_URL_CREDENTIALS@localhost:5432/demo");
    expect(result.text).not.toContain("hunter2");
    const hit = result.report.byRule.find((rule) => rule.rule === "url-credentials");
    expect(hit?.count).toBe(1);
  });

  it("leaves a URL with no credentials alone", () => {
    const input = "DATABASE_URL=postgres://localhost:5432/demo";
    const result = redactText(input, { surface: "files/.env.example" });
    expect(result.text).toBe(input);
    expect(result.report.totalMatches).toBe(0);
  });
});

describe("findResidualSecrets ignores artifacts of its own output", () => {
  it("does not read a placeholder glued to a host as a fresh secret", () => {
    // Regression: redacting the whole "scheme://user:pass@" prefix used to
    // leave "REDACTED_URL_CREDENTIALS@localhost:5432/demo", and the assignment
    // rule then read that as a secret named ...CREDENTIALS whose value was the
    // host. Every bundle captured from a directory containing a .env with a
    // credentialed URL failed verify with a blocker it could never clear.
    const text = "DATABASE_URL=REDACTED_URL_CREDENTIALS@localhost:5432/demo";
    expect(findResidualSecrets(text)).toHaveLength(0);
  });

  it("still reports a real secret that survived redaction", () => {
    const survived = "API_TOKEN=" + "s".repeat(24);
    const hits = findResidualSecrets(survived);
    expect(hits.some((hit) => hit.rule === "assigned-secret")).toBe(true);
  });
});
