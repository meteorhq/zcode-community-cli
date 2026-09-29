# zcode-community-cli

Community npm packaging of the **open-source ZCode CLI** — the official agent runtime and TUI from [zai-org/ZCode](https://github.com/zai-org/ZCode), built from source and published as a single installable global CLI.

> **Unofficial.** This project is maintained by community members and is not affiliated with Z.AI. The `zcode` runtime inside is built unmodified from the upstream open-source repository; see provenance below.

## Install

```bash
npm install -g zcode-community-cli
```

Requirements:

- **Node.js >= 22.18**（type-stripping support is required at runtime；Node 24 LTS recommended）
- The native module `koffi` ships prebuilt binaries for common platforms; on minimal Linux systems a compiler toolchain may be needed if no prebuild matches.

## Usage

```bash
zcode            # open the full-screen TUI in the current directory
zcode doctor     # inspect runtime and packaging assumptions
zcode --version
zcode --licenses # print bundled third-party notices
```

Other built-in commands follow upstream (`app-server`, `login [zai|bigmodel]`, `logout`, `commands list`, …). Run `zcode --help` or see the upstream repo for details.

## How this package is built

The upstream repository open-sources the CLI but does not publish it to npm. This repo closes that gap **without forking runtime code**:

1. The ZCode source is resolved in this order: `--source <path>` / `ZCODE_SOURCE` env, a local checkout next to this repo, or — fully self-contained — a shallow `git clone` of the ref pinned in [`upstream.json`](upstream.json) (a tag, e.g. `v3.14.3`) into `.upstream/`, with dependencies installed automatically. This is exactly what CI does.
2. The CLI is built inside that source repo using upstream's own commands (`turbo run build` + `scripts/build.mjs --desktop-agent`, i.e. the same minified bundle the desktop app ships).
3. The bundle (`dist/zcode.cjs`) keeps `@zcode/tui`, `playwright-core` and `koffi` external by design. The `@zcode/*` workspace packages that are resolved at runtime (`tui`, `shared`, `contracts`, `i18n`, `model-option-map`) are vendored under `dist/node_modules/@zcode/`, mirroring the source workspace layout; the rest are regular pinned npm dependencies of this package.
4. `dist/BUILD_INFO.json` records the exact source commit and upstream version each tarball was built from.

Useful build flags: `--upstream` (force the clone path), `--refresh` (drop `.upstream/` and re-clone), `--upstream-ref <tag>` (one-off override of the pinned ref), `--no-build` (re-stage from an already-built source tree).

## Rebuilding locally

```bash
npm install                      # installs this package's runtime deps
npm run build                    # auto-clones upstream per upstream.json if no local source
npm run verify                   # smoke tests + tarball completeness + version policy check
```

If you keep a checkout of the upstream repo around (e.g. `~/Projects/ZCode`), the build reuses it automatically; pass `--source <path>` to be explicit.

## Automated releases (GitHub Actions)

- **CI** (`.github/workflows/ci.yml`): on every push/PR — build from the pinned upstream ref and run the full verification. No publish.
- **Release** (`.github/workflows/release.yml`): manual `workflow_dispatch` — build, verify, then `npm publish --provenance --access public`. Toggle the `dry-run` input to rehearse without publishing.

Setup once in the GitHub repo settings:

1. Add an `NPM_TOKEN` secret (an npm access token with publish rights for `zcode-community-cli`).
2. Releasing a new upstream version: bump `ref` in `upstream.json` to the new tag, bump `package.json` `version` to the upstream `apps/zcode-cli` version, commit, then run the Release workflow.

`npm run verify` enforces the version policy: the package version must equal the upstream `apps/zcode-cli` version, or be `<upstream>-N` for packaging-only republishes.

## Versioning

Versions mirror `apps/zcode-cli/package.json` in the upstream repo. If a packaging-only fix is needed for the same upstream version, a prerelease suffix is used (`0.16.9-1`).

## License

- Upstream ZCode source: **Apache-2.0** (see `LICENSE`, full text from the upstream repository).
- Bundled third-party components keep their original licenses; the consolidated notice file is shipped inside the package (`dist/THIRD-PARTY-NOTICES.md`, also printable via `zcode --licenses`).
- Packaging scripts in this repository: Apache-2.0.

---

## 中文说明

社区维护的 **ZCode 开源 CLI 的 npm 打包**：上游 [zai-org/ZCode](https://github.com/zai-org/ZCode) 开源了 CLI 源码但未发布 npm 包，本仓库用上游自己的构建脚本从源码构建，并以单一 npm 包形式分发（`bin` 命令仍为 `zcode`）。

- 安装：`npm install -g zcode-community-cli`（要求 Node ≥ 22.18，推荐 Node 24）。
- 非官方包，与 Z.AI 无隶属关系；产物溯源信息见包内 `dist/BUILD_INFO.json`。
- 构建方式：按 `upstream.json` 锁定的 tag 自动浅克隆上游源码（或复用本地 checkout），用上游官方构建脚本出包。
- 本地重建：`npm run build && npm run verify`。
- 自动发布：仓库自带 GitHub Actions（CI 每次推送构建验证；Release 手动触发发布到 npm，需在仓库 Secrets 配置 `NPM_TOKEN`）。
