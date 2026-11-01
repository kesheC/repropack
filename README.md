# repropack

**把一次失败的运行打包成另一台机器能复现的东西。**

[![CI](https://github.com/kesheC/repropack/actions/workflows/ci.yml/badge.svg)](https://github.com/kesheC/repropack/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Runtime dependencies](https://img.shields.io/badge/runtime%20dependencies-0-brightgreen.svg)](package.json)
[![Node](https://img.shields.io/badge/node-%3E%3D20.11-informational.svg)](package.json)

---

## The problem / 痛点

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

**中文：**

一条 bug 报告通常只有一句话「在我机器上崩了」加一张截图。于是你追问报错原文，再问 Node 版本、操作系统，再问「能不能把出错的那个文件发给我」。两天过去，来回了六条消息，仍然没有复现——因为真正重要的东西（准确的命令、准确的输入、准确的环境）都留在一台你看不见的机器上。

`repropack` 把这整个来回压缩成一个产物：它运行那条失败的命令，记录它需要的东西，擦掉不能公开的东西，写出一个可以直接附到 issue 里的 bundle。拿到它的人用一条命令就能重放同一个失败——不用 clone，不用安装，不用注册。

## What it actually does / 它到底做什么

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

**中文：**

四条命令各做一件事：`capture` 运行命令并记录、脱敏；`verify` 在产物离开你机器之前做一次审计；`pack` 把目录收成单个 `.repropack` 文件；`replay` 在另一台机器上重放同一个失败、拿到同一个退出码。

上面第二个 console 块展示了一次真实抓取：运行失败的命令，bundle 被写到目录里，然后是清单摘要——bundle id、创建时间、命令、退出码、耗时 68ms、Node 版本 v24.22.1（win32/x64）、仓库为 none、4 个文件共 1.3 KB、2 条命中分布在 2 条规则上。第三个 console 块是重放：拿到同样的退出码 1，并注明「replayed faithfully」。

这就是全部意义：报错的人看到的 `NaN`，变成你看到的 `NaN`，中间不需要来回。

## Install / 安装

> **The name `repropack` on npm belongs to a different project by another author**
> ([`saivarun1410/repropack`](https://github.com/saivarun1410/repropack)), so this project
> cannot use it. Every release here ships a ready-to-install tarball instead.

```sh
npm install -g https://github.com/kesheC/repropack/releases/latest/download/repropack.tgz
repropack --version
```

Every release publishes the same tarball under a stable name (`repropack.tgz`) alongside a
`repropack.tgz.sha256` checksum. To verify the download before running it:

```bash
curl -sLO https://github.com/kesheC/repropack/releases/latest/download/repropack.tgz
curl -sLO https://github.com/kesheC/repropack/releases/latest/download/repropack.tgz.sha256
sha256sum -c repropack.tgz.sha256          # repropack.tgz: OK
npm install -g ./repropack.tgz
```

On macOS use `shasum -a 256 -c repropack.tgz.sha256` — there is no `sha256sum` by default.

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

**中文：**

npm 上的 `repropack` 这个名字属于另一位作者的另一个项目（[`saivarun1410/repropack`](https://github.com/saivarun1410/repropack)），所以本项目不能占用它；这里的每个 release 改为提供一个可直接安装的 tarball。

安装命令就是 `npm install -g` 加上 release 的固定下载地址，装完用 `repropack --version` 验证。每个 release 都会在固定名字 `repropack.tgz` 之外同时提供 `repropack.tgz.sha256` 校验文件；下载后先校验再安装：`curl -sLO` 两个文件，`sha256sum -c repropack.tgz.sha256` 应输出 `repropack.tgz: OK`，然后 `npm install -g ./repropack.tgz`。macOS 默认没有 `sha256sum`，改用 `shasum -a 256 -c repropack.tgz.sha256`。

也可以从源码构建：`git clone` → `cd repropack` → `npm ci` → `npm run build` → `npm link`，最后一步会把 `repropack` 放到 PATH 上。两条路径都没有运行时依赖需要下载。

要求 Node >= 20.11。构建就是普通的 `tsc`，除了类型剥离之外没有打包，也没有转译。

直接从 git 安装（`npm install -g git+https://github.com/...`）**不行**：克隆下来的目录没有构建产物，而全局安装会跳过 `devDependencies`，也就没有 `tsc` 帮你构建。请用 tarball，或者自己克隆并构建。

## Commands / 命令

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

A flag a command does not have is a usage error (exit 2), and so is a flag left
without its value — the two are never confused:

```text
$ repropack capture --out
error: --out needs a value
hint: run 'repropack capture --help' for the supported options
$ repropack capture --nope -- node -e 0
error: unknown option '--nope'; did you mean '--scope'?
hint: run 'repropack capture --help' for the supported options
```

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

**中文：**

六个子命令的分工：`capture` 运行命令、记录失败、脱敏、写出 bundle 目录；`verify` 审计已完成的 bundle，查残留密钥、损坏的哈希和绝对路径；`replay` 在干净目录里展开 bundle 并重跑记录的命令，接受 bundle 目录**或** `.repropack` 归档；`inspect` 只打印 bundle 里有什么、不运行任何东西；`pack` 把 bundle 收成单个 `.repropack` 文件（gzip 过的 tar）；`report` 从 bundle 生成 Markdown 格式的 issue 正文。

全部 flag 见 `repropack --help`，最常调整的几个：`--scope changed|tracked|all` 默认 `changed`，只发送 git 认为有差异的文件，`all` 发送整个工作树；`--include <glob>` 强制把文件纳入、可重复；`--exclude <glob>` 把文件排除、可重复；`--max-file-bytes <n>` 默认 262144，单文件上限；`--max-bundle-bytes <n>` 默认 8388608，整包上限；`--timeout <ms>` 默认 300000，命令卡住就杀掉；`--no-git` 跳过仓库探测（没有 git，或当前目录不是仓库）。

所有子命令都接受 `--json`，方便管道接 `jq`；机器输出始终在 stdout，人看的进度始终在 stderr。

命令没有的 flag 是 usage error（exit 2），flag 后面没跟值同样是 usage error——两者不会混为一谈：

```text
$ repropack capture --out
error: --out needs a value
hint: run 'repropack capture --help' for the supported options
$ repropack capture --nope -- node -e 0
error: unknown option '--nope'; did you mean '--scope'?
hint: run 'repropack capture --help' for the supported options
```

**这里有一个陷阱：`--scope changed`**

默认 scope 是 `changed`，当 bug 出在你尚未提交的改动里时它是对的，当 bug 出在已经提交的代码里时它是错的：bundle 最后几乎什么都没有，重放因为缺少 import 而失败，而不是复现原来那个 bug。

栈帧能缓解这一点。无论选哪个 scope，capture 都会把栈帧里提到的文件扩展到它们在本地的 import 闭包——从抛错的那一帧出发跟随 `./mathy.js`，再跟随那个文件 import 的东西——所以一个很小的 bundle 也能真正跑起来，而不是以 `ERR_MODULE_NOT_FOUND` 死掉、因为错误的原因「复现」了退出码。离开本项目的 import 和 `node_modules` 里的东西不会被打进去。

拿不准时就传 `--scope all`，让 `--max-bundle-bytes` 去拦超量；`verify` 会告诉你 bundle 是不是太薄。

## What's in a bundle / 产物结构

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

**中文：**

bundle 目录的固定结构：`bundle.json` 是清单，记录命令、argv、退出码、环境与文件哈希；`files/` 是失败触及的源码树，已脱敏；`logs/` 下是捕获的输出，`stdout.txt` 与 `stderr.txt` 都已脱敏，过长时保留尾部；`Dockerfile` 由记录下来的环境推导；`replay.sh` 是 POSIX 入口，从 `files/` 里运行；`replay.cmd` 是对应的 Windows 版本。

`bundle.json` 里带有对规范序列化结果的 SHA-256，每个文件也各自带哈希。文件缺失或哈希对不上时，replay 会拒绝宣称这次重放是「忠实的」——损坏的 bundle 会明确报错，而不是产生一个令人困惑的「测试现在通过了」。

`.repropack` 归档就是普通的 gzip 过的 tar，所以 `tar -xf` 也能解开；查看内容完全不需要装 repropack。

## Redaction / 脱敏

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

**中文：**

任何内容在写盘之前都先被扫描过。19 条规则覆盖私钥块，AWS / GitHub / OpenAI / Anthropic / Stripe / Slack / Google / npm / PyPI 令牌，JWT，嵌在 URL 里的凭据，`password=` 形式的赋值，authorization 头与 bearer 令牌，以及用户主目录路径。每处命中都替换成一个具名占位符——比如 `REDACTED_GITHUB_TOKEN`——这样读者仍然知道那里原本是什么形态的密钥，但看不到值。

命令行本身也会被脱敏，因为它是唯一会原样进入 issue 的字段：一个作为参数传进去的 token，否则会在标题和表格里各被公开一次。

`repropack verify` 会重新扫描一个已完成的 bundle，报告有什么残留下来。把任何东西贴到公开 issue 之前先跑它，输出应为 `no findings` 与 `ok (0 finding(s))`。它在存在阻断项时以非零退出，因此可以在脚本里当作发布前门禁。

## Library API / 库 API

The CLI is a thin layer over an importable library; there are no global
singletons and no `process.exit` inside it.

```ts
import { capture, verifyBundle, replay, readBundle } from "repropack";

const { bundle, root } = await capture({
  argv: ["node", "src/main.js"],
  scope: "all",
  out: "./bundle",
  toolVersion: "0.1.9",
});

const verified = await verifyBundle(root, { strict: true });
if (!verified.ok) throw new Error("refusing to publish a leaky bundle");
```

Lower-level pieces are exported too — `redactText`, `scanWorktree`,
`probeEnvironment`, `writeBundle`/`readBundle`, `packBundle`/`unpackBundle`,
`buildReport` — so a CI job can redact a log without capturing a run, or read a
bundle without replaying it.

**中文：**

CLI 只是一层很薄的外壳，底下是可导入的库；库内部没有全局单例，也不会调用 `process.exit`。

主入口是 `capture`、`verifyBundle`、`replay`、`readBundle`：`capture` 接收 `argv`、`scope`、`out`、`toolVersion` 等选项，返回 `{ bundle, root }`；`verifyBundle(root, { strict: true })` 返回带 `ok` 的审计结果，不通过就抛错，从而拒绝发布一个泄漏的 bundle。

更底层的部件也一并导出——`redactText`、`scanWorktree`、`probeEnvironment`、`writeBundle`/`readBundle`、`packBundle`/`unpackBundle`、`buildReport`——所以 CI 任务可以在不抓取一次运行的前提下脱敏一份日志，或者在不重放的前提下读取一个 bundle。

## Design notes / 设计取舍

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

**中文：**

- **零运行时依赖。** 全部是 `node:*` 和标准库。一个以「让别人能复现 bug」为己任的工具，不能反过来成为别人安装失败的原因。
- **脱敏是纯粹的 `string -> string` 变换，发生在任何写盘之前。** 是 writer 调用它，不是它调用 writer。这个先后顺序就是安全性质本身，不是约定。
- **用 span，不用反复 `replace`。** `redactText` 先收集互不重叠的区间再一次性重建。若每条规则各自 `replace`，后面的规则就可能匹配到前面规则刚插入的占位符内部。
- **文件选择跟随 import，而不只是栈帧。** 栈帧只指出是哪一行抛的错；那一行调用的模块才是重放真正需要的，所以对本地 import 做闭包，才让一个四文件的 bundle 变成能跑起来的 bundle。
- **重放意味着同样的退出码，不是同样的字节。** 耗时、临时路径、随机 id 每次都不同；逐字节比较 stdout 几乎会让每个真实 bundle 都报假阴性。
- **机器相关的环境会被记录，但绝不重放。** `PATH`、`HOME`、`TEMP` 解释了原运行为什么失败；重放它们要么让运行直接坏掉，要么悄悄解析到另一个二进制。
- **Dockerfile 是起点，不是验证过的构建。** repropack 不要求 Docker，所以镜像是从记录的指纹推导出来的。生成的文件会在注释里如实说明这一点，而不是假装它是验证过的。

## Limits, stated plainly / 明确的边界

- It does not fix the bug. It makes the bug reproducible somewhere else.
- A capture of a *successful* command is recorded with a warning; the tool is
  built around failures.
- Files over `--max-file-bytes` are skipped with a warning, not silently dropped.
- `--scope changed` needs git; without it the scope degrades to every unignored
  file and says so.
- Only Node-style and common language stack frames seed the file selection; a
  language that prints no parseable trace needs `--include`.

**中文：**

- 它不修 bug，它只是让 bug 能在别处复现。
- 对**成功**命令的抓取会带着 warning 被记录下来；这个工具是围绕失败构建的。
- 超过 `--max-file-bytes` 的文件会被跳过并记 warning，不会悄悄丢掉。
- `--scope changed` 需要 git；没有 git 时 scope 降级为「所有未被忽略的文件」，并会明确说明。
- 只有 Node 风格和常见语言的栈帧会作为文件选择的种子；一种打印不出可解析 trace 的语言需要传 `--include`。

## Development / 开发

```sh
npm run typecheck
npm test          # builds first, then runs vitest
```
[`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md) documents the module layout, the
constraints, and the two invariants the rest of the code depends on.

**中文：**

自检的两个命令：`npm run typecheck` 做类型检查，`npm test` 先构建再跑 vitest。

[`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md) 记录了模块划分、约束条件，以及其余代码所依赖的两条不变量。

## Security and changes / 安全与变更

Found a vulnerability? Please do not open a public issue — [SECURITY.md](SECURITY.md)
explains the private reporting channel and what to include. Every release is written
up in [CHANGELOG.md](CHANGELOG.md).

**中文：**

发现漏洞？请不要开公开 issue——[SECURITY.md](SECURITY.md) 说明了私密上报渠道以及需要提交什么。每个版本的变动都写在 [CHANGELOG.md](CHANGELOG.md) 里。

## License / 许可证

MIT — see [LICENSE](LICENSE).

**中文：**

MIT——见 [LICENSE](LICENSE)。

