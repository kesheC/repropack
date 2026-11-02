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

```bash
git clone https://github.com/kesheC/repropack.git
cd repropack
npm ci
npm run build
node dist/cli.js --help
```

`dist/` is what the published tarball ships, so `npm run build` has to succeed for anything to be
reviewable. `node dist/cli.js` runs the build you just made; a `repropack` on your PATH is whatever
release you installed earlier and is usually stale.

## The quality gates

Every change has to pass the same three commands CI runs:

```bash
npm run typecheck   # tsc --noEmit, tests included
npm run build       # tsc -p tsconfig.build.json
npm test            # vitest run
```

Opening the pull request runs them on Ubuntu and Windows across Node 20, 22 and 24. If a change
touches a transcript the README quotes, CI re-runs that transcript too and fails when the quoted
output no longer matches.

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
