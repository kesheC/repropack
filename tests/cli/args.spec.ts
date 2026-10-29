import { describe, expect, it } from "vitest";
import {
  flagBool,
  flagList,
  flagNumber,
  flagString,
  parseArgs,
  type FlagSpec,
} from "../../src/cli/args.js";

/**
 * The spec table mirrors the real CAPTURE/REPLAY tables in src/cli/main.ts:
 * every branch of the parser (inline value, separate value, alias, repeatable,
 * boolean, negation, terminator) is reachable from here.
 */
const SPECS: readonly FlagSpec[] = [
  { name: "help", type: "boolean", aliases: ["h"] },
  { name: "version", type: "boolean" },
  { name: "json", type: "boolean" },
  { name: "quiet", type: "boolean", aliases: ["q"] },
  { name: "out", type: "string", aliases: ["o"] },
  { name: "scope", type: "string" },
  { name: "include", type: "string", aliases: ["i"], repeatable: true },
  { name: "max-file-bytes", type: "number" },
  { name: "timeout", type: "number" },
  { name: "no-git", type: "boolean" },
];

const parse = (argv: readonly string[]) => parseArgs(argv, SPECS);

describe("parseArgs: the two spellings of a value flag", () => {
  it("treats --out x and --out=x identically", () => {
    const spaced = parse(["--out", "bundle-dir"]);
    const joined = parse(["--out=bundle-dir"]);
    expect(spaced.flags).toEqual(joined.flags);
    expect(spaced.positionals).toEqual(joined.positionals);
    expect(flagString(spaced, "out")).toBe("bundle-dir");
    expect(flagString(joined, "out")).toBe("bundle-dir");
  });

  it("accepts the short alias in both spellings", () => {
    expect(flagString(parse(["-o", "a"]), "out")).toBe("a");
    expect(flagString(parse(["-o=a"]), "out")).toBe("a");
  });

  it("keeps an empty inline value instead of falling through to the next token", () => {
    const args = parse(["--out=", "positional"]);
    expect(args.flags["out"]).toBe("");
    expect(args.positionals).toEqual(["positional"]);
  });
});

describe("parseArgs: booleans and negation", () => {
  it("sets a bare boolean flag to true", () => {
    expect(flagBool(parse(["--json"]), "json")).toBe(true);
    expect(flagBool(parse(["--json"]), "quiet")).toBe(false);
  });

  it("sets a spec literally named no-git to true when written as --no-git", () => {
    // The flag is declared as { name: "no-git" }, so "--no-git" is its plain,
    // non-negated spelling and must read back as true. main.ts consumes it via
    // flagBool(args, "no-git"), which is exactly this record lookup.
    const args = parse(["--no-git"]);
    expect(args.flags["no-git"]).toBe(true);
    expect(flagBool(args, "no-git")).toBe(true);
    expect(args.unknown).toEqual([]);
  });

  it("negates a positive boolean spec: --no-keep turns keep off", () => {
    // This is what the "no-" prefix is for when no spec claims it: a boolean
    // declared as { name: "keep" } is switched off. main.ts relies on it.
    const specs: readonly FlagSpec[] = [{ name: "keep", type: "boolean" }];
    expect(parseArgs(["--keep"], specs).flags["keep"]).toBe(true);
    expect(parseArgs(["--no-keep"], specs).flags["keep"]).toBe(false);
    expect(flagBool(parseArgs(["--no-keep"], specs), "keep")).toBe(false);
  });

  it("keeps --no-git distinct from an omitted flag", () => {
    // flagBool collapses both to false, but the record knows the difference;
    // that is what lets a caller distinguish "explicitly requested".
    expect(parse([]).flags["no-git"]).toBeUndefined();
    expect(parse(["--no-git"]).flags["no-git"]).toBe(true);
  });

  it("honours an explicit false inline value", () => {
    expect(parse(["--json=false"]).flags["json"]).toBe(false);
    expect(flagBool(parse(["--json=false"]), "json")).toBe(false);
  });

  it("treats any other inline value as true", () => {
    // Documented quirk: only the literal "false" turns a boolean off.
    expect(parse(["--json=0"]).flags["json"]).toBe(true);
    expect(parse(["--json=1"]).flags["json"]).toBe(true);
  });

  it("does not let a boolean swallow the following token as its value", () => {
    const args = parse(["--json", "capture-thing"]);
    expect(flagBool(args, "json")).toBe(true);
    expect(args.positionals).toEqual(["capture-thing"]);
  });
});

describe("parseArgs: repeatable flags", () => {
  it("accumulates repeated flags into an array", () => {
    const args = parse(["--include", "a.ts", "--include", "b.ts", "-i", "c.ts"]);
    expect(flagList(args, "include")).toEqual(["a.ts", "b.ts", "c.ts"]);
    expect(args.flags["include"]).toEqual(["a.ts", "b.ts", "c.ts"]);
  });

  it("mixes inline and separate values without losing the first one", () => {
    const args = parse(["--include=a.ts", "--include", "b.ts"]);
    expect(flagList(args, "include")).toEqual(["a.ts", "b.ts"]);
  });

  it("lets a non-repeatable flag overwrite itself", () => {
    expect(flagString(parse(["--out", "first", "--out", "second"]), "out")).toBe("second");
  });
});

describe("parseArgs: positionals and the -- terminator", () => {
  it("collects plain arguments in order, interleaved with flags", () => {
    const args = parse(["capture", "--json", "node", "-q", "script.js"]);
    expect(args.positionals).toEqual(["capture", "node", "script.js"]);
    expect(flagBool(args, "json")).toBe(true);
    expect(flagBool(args, "quiet")).toBe(true);
  });

  it("treats a lone - as a positional (the stdin idiom)", () => {
    const args = parse(["-o", "-"]);
    expect(flagString(args, "out")).toBe("-");
    expect(args.positionals).toEqual([]);
    expect(parse(["-"]).positionals).toEqual(["-"]);
  });

  it("puts everything after -- into positionals, even dash-prefixed tokens", () => {
    const args = parse(["--json", "--", "node", "--experimental-x", "-e", "process.exit(3)"]);
    expect(args.positionals).toEqual(["node", "--experimental-x", "-e", "process.exit(3)"]);
    expect(flagBool(args, "json")).toBe(true);
    expect(args.unknown).toEqual([]);
    expect(args.flags["experimental-x"]).toBeUndefined();
  });

  it("stops parsing at -- even when the tail looks like a known flag", () => {
    const args = parse(["--", "--json", "--out", "x"]);
    expect(args.positionals).toEqual(["--json", "--out", "x"]);
    expect(args.flags).toEqual({});
  });

  it("handles a trailing -- with nothing after it", () => {
    const args = parse(["node", "--"]);
    expect(args.positionals).toEqual(["node"]);
  });

  it("returns empty collections for an empty argv", () => {
    expect(parse([])).toEqual({ positionals: [], flags: {}, unknown: [] });
  });
});

describe("parseArgs: unknown and malformed input", () => {
  it("routes unknown long flags to unknown without throwing", () => {
    const args = parse(["--nope", "--json"]);
    expect(args.unknown).toEqual(["--nope"]);
    expect(flagBool(args, "json")).toBe(true);
    expect(args.positionals).toEqual([]);
  });

  it("routes an unknown --no- flag to unknown", () => {
    expect(parse(["--no-such-thing"]).unknown).toEqual(["--no-such-thing"]);
  });

  it("routes a flag with a missing value to unknown", () => {
    const args = parse(["--out"]);
    expect(args.unknown).toEqual(["--out"]);
    expect(args.flags["out"]).toBeUndefined();
  });

  it("treats a following flag as a missing value, not as the value", () => {
    const args = parse(["--out", "--json"]);
    expect(args.unknown).toEqual(["--out"]);
    expect(args.flags["out"]).toBeUndefined();
    // The next token is still parsed normally: the loop must not skip it.
    expect(flagBool(args, "json")).toBe(true);
  });

  it("keeps positionals that follow a malformed flag", () => {
    const args = parse(["--out", "node", "x.js"]);
    // "node" is a legal value here, so this is not malformed: it is the classic
    // footgun the -- terminator exists for.
    expect(flagString(args, "out")).toBe("node");
    expect(args.positionals).toEqual(["x.js"]);
  });

  it("records unknown flags in encounter order", () => {
    const args = parse(["--b", "--a", "--json"]);
    expect(args.unknown).toEqual(["--b", "--a"]);
  });
});

describe("flag accessors", () => {
  const args = parse(["--out", "dir", "--max-file-bytes", "2048", "--timeout", "abc", "--include", "one"]);

  it("flagString returns the value and undefined otherwise", () => {
    expect(flagString(args, "out")).toBe("dir");
    expect(flagString(args, "scope")).toBeUndefined();
    expect(flagString(args, "json")).toBeUndefined();
  });

  it("flagNumber parses digits and rejects non-numeric input", () => {
    expect(flagNumber(args, "max-file-bytes")).toBe(2048);
    expect(flagNumber(args, "timeout")).toBeUndefined();
    expect(flagNumber(args, "out")).toBeUndefined();
    expect(flagNumber(args, "scope")).toBeUndefined();
  });

  it("flagBool is true only for an explicit true", () => {
    expect(flagBool(args, "json")).toBe(false);
    expect(flagBool(parse(["--json"]), "json")).toBe(true);
    expect(flagBool(parse(["--json=false"]), "json")).toBe(false);
  });

  it("flagList wraps a single value and returns [] when absent", () => {
    expect(flagList(args, "include")).toEqual(["one"]);
    expect(flagList(args, "scope")).toEqual([]);
    expect(flagList(args, "json")).toEqual([]);
    expect(flagList(parse(["--include", "a", "--include", "b"]), "include")).toEqual(["a", "b"]);
  });
});