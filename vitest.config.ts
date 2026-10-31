import { defineConfig } from "vitest/config";

// The default vitest testTimeout is 5s. Several suites shell out to git in
// beforeAll hooks and the Windows runners regularly need more than that,
// which shows up as a flaky failure on one matrix leg and not the others.
// The suite is fast in wall-clock terms; a single long test is the norm here.
export default defineConfig({
  test: {
    environment: "node",
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
