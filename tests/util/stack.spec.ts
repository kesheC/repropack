import { describe, expect, it } from "vitest";
import { isRuntimePath, parseStackFrames, stripFileUrl } from "../../src/util/stack.js";

describe("parseStackFrames", () => {
  it("reads node/v8 frames", () => {
    const trace = [
      "TypeError: boom",
      "    at run (/home/u/app/src/run.ts:12:34)",
      "    at /home/u/app/src/main.ts:5:1",
    ].join("\n");
    const frames = parseStackFrames(trace);
    expect(frames.map((f) => f.raw)).toEqual(["/home/u/app/src/run.ts", "/home/u/app/src/main.ts"]);
    expect(frames[0]?.line).toBe(12);
    expect(frames[0]?.column).toBe(34);
  });

  it("reads python frames", () => {
    const trace = '  File "/home/u/app/test_thing.py", line 42, in test_x';
    const frames = parseStackFrames(trace);
    expect(frames[0]?.raw).toBe("/home/u/app/test_thing.py");
    expect(frames[0]?.line).toBe(42);
  });

  it("reads node esm frames on windows, which carry a file:/// scheme", () => {
    // Without this case a Windows capture of an ESM project finds zero stack
    // frames, so "capture the files the crash touched" silently captures none.
    const frames = parseStackFrames(
      "Error: boom\n    at file:///C:/work/app/src/main.js:13:11\n    at ModuleJob.run (node:internal/modules/esm/module_job:561:25)",
    );
    expect(frames).toHaveLength(1);
    expect(frames[0]?.raw).toBe("C:/work/app/src/main.js");
    expect(frames[0]?.line).toBe(13);
    expect(frames[0]?.column).toBe(11);
  });

  it("reads windows paths", () => {
    const trace = "    at Object.<anonymous> (C:\\proj\\src\\a.ts:3:9)";
    const frames = parseStackFrames(trace);
    expect(frames[0]?.raw).toBe("C:\\proj\\src\\a.ts");
  });

  it("deduplicates the same file appearing many times", () => {
    const trace = ["at f (/a/b.ts:1:1)", "at g (/a/b.ts:9:9)", "at h (/a/c.ts:2:2)"].join("\n");
    expect(parseStackFrames(trace).map((f) => f.raw)).toEqual(["/a/b.ts", "/a/c.ts"]);
  });

  it("returns nothing for a trace-free log", () => {
    expect(parseStackFrames("all good")).toEqual([]);
  });

  it("honours the limit", () => {
    const trace = Array.from({ length: 50 }, (_, i) => "at f (/a/f" + i + ".ts:1:1)").join("\n");
    expect(parseStackFrames(trace, 5)).toHaveLength(5);
  });
});

describe("stripFileUrl", () => {
  it("unwraps a posix file url", () => {
    expect(stripFileUrl("file:///home/u/a.ts")).toBe("/home/u/a.ts");
  });

  it("unwraps a windows file url", () => {
    expect(stripFileUrl("file:///C:/proj/a.ts")).toBe("C:/proj/a.ts");
  });

  it("leaves a plain path alone", () => {
    expect(stripFileUrl("/a/b.ts")).toBe("/a/b.ts");
  });
});

describe("isRuntimePath", () => {
  it("flags node_modules and site-packages", () => {
    expect(isRuntimePath("/a/node_modules/b/index.js")).toBe(true);
    expect(isRuntimePath("/usr/lib/python3/site-packages/x.py")).toBe(true);
    expect(isRuntimePath("/home/u/.cargo/registry/x.rs")).toBe(true);
  });

  it("does not flag project files", () => {
    expect(isRuntimePath("/home/u/proj/src/index.ts")).toBe(false);
  });
});
