# Development notes (internal)

This file describes the module layout so contributors (human or agent) do not
have to reverse-engineer it from imports. It is written for people working *on*
repropack, not for users — see `README.md` for that.

## Hard constraints

1. **Zero runtime dependencies.** `dependencies` in `package.json` stays empty.
   Everything ships from `node:*` plus the standard library. Dev dependencies
   (typescript, vitest, @types/node) are fine.
2. **ESM only.** `"type": "module"`, `moduleResolution: NodeNext`, relative
   imports must carry the `.js` extension even though the source is `.ts`.
3. **strict TypeScript**, including `noUncheckedIndexedAccess`. Indexing an array
   yields `T | undefined`; handle it or the build fails.
4. **stdout is machine output, stderr is human output.** The CLI must keep this
   split or piping `repropack inspect --json` into `jq` breaks.
5. **Node >= 20.11** is the floor, and `package.json`, this file and the CI
   matrix all say so. 20.11 is where `import.meta.dirname` and the modern
   `node:fs/promises` behaviour we rely on are stable; the CI matrix runs 20 and
   22, so anything newer is not allowed either.

## Layout

```
src/
  types.ts          The bundle contract. FROZEN — see below.
  version.ts        TOOL_VERSION, asserted against package.json by a test.
  util/hash.ts      sha256, canonicalJson (sorted keys), bundleId
  util/bytes.ts     formatBytes, truncateUtf8, elideMiddle, tailUtf8
  util/exec.ts      run(argv, opts) with shell:false, runCapture, tryCapture
  util/log.ts       Logger (writes to stderr)
  util/stack.ts     parseStackFrames for Node/Python/Go/Java traces
  redact/           Secret + PII scrubbing. rules.ts is the table, engine.ts the span renderer.
  bundle/           manifest.ts (integrity/shape), write.ts, read.ts
  capture/          Build a bundle from a live command run: scan, git, env, redaction staging.
  verify/           Audit a finished bundle before it leaves the machine.
  replay/           Reconstruct and re-run a bundle, including from a .repropack archive.
  export/           Dockerfile, replay.sh and replay.cmd generation.
  archive/          tar/gzip and the .repropack pack/unpack round trip.
  report/           Markdown issue body.
  cli/              Argument parsing, formatting and command handlers.
  index.ts          Public library API.
tests/              vitest specs
```

## `src/types.ts` is frozen

Every module imports its data shapes from `types.ts`. Do not edit it without
coordinating: a field rename there breaks `bundle.json` compatibility and every
parallel workstream at once. If a shape genuinely needs a new optional field,
add it as optional and bump nothing; if a field must change meaning, bump
`BUNDLE_FORMAT_VERSION` and say so in the PR description.

## The two invariants everything else depends on

**1. Redaction runs before anything hits disk.** `capture` never writes a
captured byte until `redactText` has processed it. This is why `redact/` has no
dependency on `bundle/`: redaction is a pure `string -> string` transform that
the writer calls, never the other way around.

**2. Offsets, not repeated `replace`.** `redactText` collects non-overlapping
spans and rebuilds the string in one pass. Running `replace` per rule would let
a later rule match inside an earlier rule's placeholder (e.g. the
`assigned-secret` rule happily matching `REDACTED_X = y`). The `d` regex flag
supplies per-group offsets so a rule can redact exactly one capture group while
keeping its label.

## Testing expectations

- Major modules have a spec under `tests/`; a few are covered by an aggregate
  spec instead of one file per module (`bundle/read.ts` and `bundle/write.ts`
  are exercised by `tests/bundle/roundtrip.spec.ts`, for example). The rule that
  actually matters: no module ships without being executed by some test.
- Tests must not depend on the machine: no absolute paths from the developer's
  home, no network, no `docker`. Anything that needs a repo runs against a
  fixture created in `os.tmpdir()`.
- Prefer table-driven cases for regex work. A redaction rule without a positive
  case *and* a negative case (a string that looks similar but must not be
  redacted) is not done.
