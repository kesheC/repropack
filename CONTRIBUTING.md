# Contributing to repropack

Thanks for wanting to help. `repropack` is a small tool that does one thing: turn a failing command into a self-contained, secret-free repro bundle that anyone can replay.

## Before you start

- **Bugs and feature ideas go to [Issues](https://github.com/kesheC/repropack/issues)**, using the
  templates there. Include the exact command and its complete output; a screenshot of a terminal is
  not reproducible.
- **Security problems never go to a public issue.** Use the private channel in
  [SECURITY.md](https://github.com/kesheC/repropack/blob/main/SECURITY.md).
- For anything larger than a typo, open an issue first and describe the problem you are trying to
  solve. A pull request that arrives before the problem is agreed on is hard to accept, however
  good the code is.

## Setting up

You need Node.js 20.11 or newer. There is nothing to install beyond dev dependencies:

> The shipped CLI runs on Node 20.11. The **test runner is newer than the runtime floor**:
> vitest 4 pulls in vite 8, which declares `^20.19.0 || >=22.12.0`. On Node 20.11–20.18 the
> tool still runs, but `npm test` does not — use a current 20.x, 22.x or 24.x to work on it.
> CI's `node: 20` column resolves to the latest 20.x, so it is above that line.

```bash
git clone https://github.com/kesheC/repropack.git
cd repropack
npm ci
npm run build
node dist/cli/index.js --help
```

`dist/` is what the published tarball ships, so `npm run build` has to succeed for anything to be
reviewable. `node dist/cli/index.js` runs the build you just made; a `repropack` on your PATH is
whatever release you installed earlier and is usually stale.

## The quality gates

Every change has to pass the commands CI runs:

```bash
npm run typecheck   # tsc --noEmit, tests included
npm run build       # tsc -p tsconfig.build.json
npm test            # vitest run
npm audit --audit-level=high   # the toolchain is the entire supply chain
```

Opening the pull request runs them on Ubuntu and Windows across Node 20, 22 and 24.

The audit is part of the gate because this package ships no runtime dependencies: what you
install to work on it *is* the whole supply chain. It fails on high and critical advisories
only; a moderate finding is worth reading when you next touch the dependencies, but it is not
worth blocking an unrelated fix.

Part of the README is already under test: `tests/package.test.ts` asserts the Redaction section
quotes `REDACTION_RULES.length`. The transcripts are not re-run by CI — the smoke step only
verifies the packed artifact — so they were checked by hand against a real run on this machine.
If you touch one, run the command and paste exactly what it printed. The demo bundle is captured
fresh each time, so a transcript that depends on `/tmp` paths or on the repository's git state
will not reproduce on someone else's checkout: prefer `--no-git` and relative paths.

## House rules

These are not style preferences; the code depends on them.

1. **Zero runtime dependencies.** `dependencies` in `package.json` stays empty — everything ships
   from `node:*` and the standard library. Dev dependencies are fine. A pull request that adds a
   dependency has to remove one first.
2. **ESM only.** `"type": "module"`, `moduleResolution: NodeNext`, and relative imports carry the
   `.js` extension even though the source is `.ts`.
3. **Strict TypeScript**, including `noUncheckedIndexedAccess`. Indexing an array yields
   `T | undefined`; handle it instead of asserting it away. `any` needs a reason in a comment.
4. **stdout is machine output, stderr is human output.** Piping the machine output into `jq` has to
   keep working, so progress notes, warnings and summaries go to stderr.
5. **Node >= 20.11 is the floor.** `package.json`, the README and the CI matrix all say so. The
   tool has to run on plain Node with no bundler and no runtime helper.

`docs/DEVELOPMENT.md` describes the module layout and the two invariants (`src/types.ts` is
frozen; redaction runs before anything hits disk). Read it before touching `src/`.

## Tests

- Every behaviour change comes with a test that fails without it. A bug fix without a test is a bug
  waiting to come back.
- Tests must not depend on the machine they run on: no absolute paths from your home directory, no
  network, no `docker`. Anything that needs a repository builds a fixture in `os.tmpdir()`.
- Table-driven cases are preferred for parsing work; include the negative case (input that looks
  similar but must not match), not just the positive one.

## Commits and pull requests

- One logical change per commit. `fix:`, `feat:`, `docs:`, `test:`, `chore:` prefixes, then a
  sentence in the imperative mood that says what the change does — not "update stuff".
- The pull request body explains **why**, and quotes the command and output that show the change
  working. "Tests pass" is not evidence that the behaviour asked for is the behaviour delivered.
- Do not bump the version or edit `CHANGELOG.md` in a feature pull request; releases are cut
  separately, from the merged history.

## Licence

By contributing you agree that your contribution is licensed under the MIT Licence in
[LICENSE](https://github.com/kesheC/repropack/blob/main/LICENSE).
