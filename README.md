# repropack

**把一次失败的运行打包成另一台机器能复现的东西。**

[![CI](https://github.com/kesheC/repropack/actions/workflows/ci.yml/badge.svg)](https://github.com/kesheC/repropack/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Runtime dependencies](https://img.shields.io/badge/runtime%20dependencies-0-brightgreen.svg)](package.json)
[![Node](https://img.shields.io/badge/node-%3E%3D20.11-informational.svg)](package.json)

---

## The problem

A bug report usually looks like this:

> It crashes on my machine. Here's a screenshot.

So you ask for the error text. Then the Node version. Then the OS. Then
"can you paste the file that's failing?" Two days later you have six messages and
still no reproduction, because everything that mattered — the exact command, the
exact inputs, the exact environment — lived on a machine you cannot see.

`repropack` collapses that exchange into one artifact. It runs the failing
command, records what it needs, scrubs what it must not publish, and writes a
bundle you can attach to an issue. Whoever opens it replays the same failure with
one command — no clone, no install, no account.

## What it actually does

```sh
repropack capture -- npm test        # run it, record it, redact it
repropack verify ./repropack-bundle  # audit before it leaves your machine
repropack pack ./repropack-bundle    # one .repropack file to attach
repropack replay demo.repropack      # on the other machine: same failure, same exit code
```

A real run, from the [`demo/`](demo) in this repository — a percent calculator
that divides by zero and throws:

```console
$ node src/main.js
widgets -> 25.0%
Error: share for gadgets is not a finite number: NaN
    at file:///…/demo/src/main.js:13:11
$ echo $?
1
```

Capture it:

```console
$ repropack capture --scope all --out ./bundle -- node src/main.js
running node src/main.js
bundle written to …/bundle
repropack bundle 755cc509efb8
  created       2026-10-29T17:26:51.471Z
  command       node src/main.js
  exit          1
  duration      68ms
  node          v24.22.1 (win32/x64)
  repo          none
  files         4 (1.3 KB)
  redacted      2 match(es) in 2 rule(s)
```

Four files, 1.3 KB, and two secrets already replaced with placeholders. Now
replay it anywhere — a different directory, a different machine, a different OS:

```console
$ repropack replay ./demo.repropack
widgets -> 25.0%
Error: share for gadgets is not a finite number: NaN
    at file:///…/src/main.js:13:11
replayed faithfully (exit 1)
```

That is the whole point: the reporter's `NaN` becomes your `NaN`, with no
back-and-forth.

## Install

> **The name `repropack` on npm belongs to an unrelated package.** This project is
> not published there. Every release ships a ready-to-install tarball instead.

```sh
npm install -g https://github.com/kesheC/repropack/releases/download/v0.1.1/repropack-0.1.1.tgz
repropack --version
```

Or build it from source — there is no runtime dependency to download either way:

```sh
git clone https://github.com/kesheC/repropack.git
cd repropack
npm ci
npm run build
npm link          # puts `repropack` on your PATH
```

Requires Node >= 20.11. The build is plain `tsc`; nothing is bundled or
transpiled beyond type stripping.

> Installing straight from git (`npm install -g git+https://github.com/...`) does
> **not** work: the checkout has no build output and a global install skips
> `devDependencies`, so there is no `tsc` to build it with. Use the tarball, or
> clone and build it yourself.

## Commands

| Command | What it does |
|---|---|
| `capture` | Run a command, record the failure, redact it, write a bundle directory. |
| `verify` | Audit a finished bundle for leftover secrets, broken hashes and absolute paths. |
| `replay` | Materialise a bundle in a clean directory and re-run the recorded command. Accepts a bundle directory *or* a `.repropack` archive. |
| `inspect` | Print what a bundle contains without running anything. |
| `pack` | Collect a bundle into a single `.repropack` file (gzipped tar). |
| `report` | Generate a Markdown issue body from a bundle. |

Run `repropack --help` for every flag. The ones that matter most:

| Flag | Default | Why you would change it |
|---|---|---|
| `--scope changed\|tracked\|all` | `changed` | `changed` sends only the files git says differ. `all` sends the working tree. Use `all` when the failing code is committed, which is most of the time — see [the trap below](#the-one-trap---scope-changed). |
| `--include <glob>` | — | Force a file in even outside the scope. Repeatable. |
| `--exclude <glob>` | — | Keep a file out. Repeatable. |
| `--max-file-bytes <n>` | 262144 | Per-file ceiling. |
| `--max-bundle-bytes <n>` | 8388608 | Whole-bundle ceiling. |
| `--timeout <ms>` | 300000 | Kill the command if it hangs. |
| `--no-git` | — | Skip the repository probe (no git available, or not a repo). |

Every command takes `--json` for piping into `jq`, and keeps machine output on
stdout with human progress on stderr.

### The one trap: `--scope changed`

The default scope is `changed`, which is right when the bug is in your
uncommitted edit and wrong when the bug is in committed code: the bundle ends up
carrying almost nothing and the replay fails on a missing import rather than on
the original bug.

Stack frames soften this. Whatever scope you pick, capture widens the files the
trace named to their local import closure — follow `./mathy.js` from the frame
that threw, and follow what that file imports — so a minimal bundle can actually
run instead of dying on `ERR_MODULE_NOT_FOUND` and "reproducing" the exit code
for the wrong reason. Imports that leave the project, and anything in
`node_modules`, stay out.

When in doubt, still pass `--scope all` and let `--max-bundle-bytes` do its job.
`verify` tells you if a bundle looks thin.

## What's in a bundle

```
bundle/
  bundle.json      the manifest: command, argv, exit code, environment, file hashes
  files/           the source tree the failure touched, redacted
  logs/
    stdout.txt     captured output, redacted, tail-preserved when huge
    stderr.txt
  Dockerfile       derived from the recorded environment
  replay.sh        POSIX entry point, runs from files/
  replay.cmd       Windows counterpart
```

`bundle.json` carries a SHA-256 over a canonical serialisation, and every file
carries its own hash. Replay refuses to call a run faithful when a file is
missing or its hash no longer matches — a corrupted bundle fails loudly instead
of producing a confusing "the test passes now".

The `.repropack` archive is a plain gzipped tar, so `tar -xf` works too, and
nothing here needs repropack installed to inspect.

## Redaction

Nothing is written to disk before it has been scanned. 19 rules cover private
key blocks, AWS/GitHub/OpenAI/Anthropic/Stripe/Slack/Google/npm/PyPI tokens,
JWTs, credentials embedded in URLs, `password=` assignments, authorization
headers and bearer tokens, plus home-directory paths. Each match becomes a named
placeholder — `REDACTED_GITHUB_TOKEN` — so a reader still knows what shape of
secret was there without seeing the value.

The command line is redacted too, because it is the one field that reaches an
issue verbatim: a token passed as an argument would otherwise be published twice,
in the title and in the table.

`repropack verify` re-scans a finished bundle and reports what survived. Run it
before you attach anything to a public issue:

```console
$ repropack verify ./bundle
no findings
ok (0 finding(s))
```

It exits non-zero on blockers, so it works as a pre-publish gate in a script.

## Library API

The CLI is a thin layer over an importable library; there are no global
singletons and no `process.exit` inside it.

```ts
import { capture, verifyBundle, replay, readBundle } from "repropack";

const { bundle, root } = await capture({
  argv: ["node", "src/main.js"],
  scope: "all",
  out: "./bundle",
  toolVersion: "0.1.1",
});

const verified = await verifyBundle(root, { strict: true });
if (!verified.ok) throw new Error("refusing to publish a leaky bundle");
```

Lower-level pieces are exported too — `redactText`, `scanWorktree`,
`probeEnvironment`, `writeBundle`/`readBundle`, `packBundle`/`unpackBundle`,
`buildReport` — so a CI job can redact a log without capturing a run, or read a
bundle without replaying it.

## Design notes

- **Zero runtime dependencies.** Everything is `node:*` and the standard library.
  A tool whose job is to make other people's bugs reproducible cannot be the
  reason their install breaks.
- **Redaction is a pure `string -> string` transform that runs before any write.**
  The writer calls it; it never calls the writer. That ordering is the safety
  property, not a convention.
- **Spans, not repeated `replace`.** `redactText` collects non-overlapping spans
  and rebuilds once. Chaining `replace` per rule lets a later rule match inside
  an earlier rule's placeholder.
- **The file selection follows imports, not just stack frames.** A frame names
  the line that threw; the modules that line called are what the replay actually
  needs, so the closure over local imports is what turns a four-file bundle into
  one that runs.
- **Replay means the same exit code, not the same bytes.** Timings, temp paths and
  random ids differ every run; comparing stdout byte-for-byte would report a false
  negative on almost every real bundle.
- **Machine-specific environment is captured but never replayed.** `PATH`, `HOME`,
  `TEMP` explain why the original run failed; replaying them would either break the
  run or silently resolve to a different binary.
- **The Dockerfile is a starting point, not a verified build.** repropack does not
  require Docker, so the image is derived from the recorded fingerprint. The
  generated file says so in a comment instead of pretending otherwise.

## Limits, stated plainly

- It does not fix the bug. It makes the bug reproducible somewhere else.
- A capture of a *successful* command is recorded with a warning; the tool is
  built around failures.
- Files over `--max-file-bytes` are skipped with a warning, not silently dropped.
- `--scope changed` needs git; without it the scope degrades to every unignored
  file and says so.
- Only Node-style and common language stack frames seed the file selection; a
  language that prints no parseable trace needs `--include`.

## Development

```sh
npm run typecheck
npm test          # builds first, then runs vitest
```
[`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md) documents the module layout, the
constraints, and the two invariants the rest of the code depends on.

## Security and changes

Found a vulnerability? Please do not open a public issue — [SECURITY.md](SECURITY.md)
explains the private reporting channel and what to include. Every release is written
up in [CHANGELOG.md](CHANGELOG.md).

## License

MIT — see [LICENSE](LICENSE).