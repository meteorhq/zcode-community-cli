# zcode-oss-cli

Community npm packaging of the **open-source ZCode CLI** — the official agent runtime and TUI from [zai-org/ZCode](https://github.com/zai-org/ZCode), built from source and published as a single installable global CLI.

> **Unofficial.** This project is maintained by community members and is not affiliated with Z.AI. The `zcode` runtime inside is built unmodified from the upstream open-source repository; see provenance below.

## Install

```bash
npm install -g zcode-oss-cli
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

1. `scripts/build-package.mjs` builds the CLI inside a local checkout of `zai-org/ZCode` using upstream's own commands (`turbo run build` + `scripts/build.mjs --desktop-agent`, i.e. the same minified bundle the desktop app ships).
2. The bundle (`dist/zcode.cjs`) keeps `@zcode/tui`, `playwright-core` and `koffi` external by design. The `@zcode/*` workspace packages that are resolved at runtime (`tui`, `shared`, `contracts`, `i18n`, `model-option-map`) are vendored under `dist/node_modules/@zcode/`, mirroring the source workspace layout; the rest are regular pinned npm dependencies of this package.
3. `dist/BUILD_INFO.json` records the exact source commit and upstream version each tarball was built from.

## Rebuilding from source

```bash
# one-time: clone the upstream source repo somewhere and point this repo at it
git clone https://github.com/zai-org/ZCode ~/Projects/ZCode

npm install                      # installs this package's runtime deps
npm run build -- --source ~/Projects/ZCode
npm run verify                   # smoke tests + tarball completeness check
```

`--source` also accepts the `ZCODE_SOURCE` environment variable. After building, publish with `npm publish` (`prepublishOnly` runs the verification automatically).

## Versioning

Versions mirror `apps/zcode-cli/package.json` in the upstream repo. If a packaging-only fix is needed for the same upstream version, a prerelease suffix is used (`0.16.9-1`).

## License

- Upstream ZCode source: **Apache-2.0** (see `LICENSE`, full text from the upstream repository).
- Bundled third-party components keep their original licenses; the consolidated notice file is shipped inside the package (`dist/THIRD-PARTY-NOTICES.md`, also printable via `zcode --licenses`).
- Packaging scripts in this repository: Apache-2.0.

---

## 中文说明

社区维护的 **ZCode 开源 CLI 的 npm 打包**：上游 [zai-org/ZCode](https://github.com/zai-org/ZCode) 开源了 CLI 源码但未发布 npm 包，本仓库用上游自己的构建脚本从源码构建，并以单一 npm 包形式分发（`bin` 命令仍为 `zcode`）。

- 安装：`npm install -g zcode-oss-cli`（要求 Node ≥ 22.18，推荐 Node 24）。
- 非官方包，与 Z.AI 无隶属关系；产物溯源信息见包内 `dist/BUILD_INFO.json`。
- 本地重新构建：`npm run build -- --source <ZCode 源码路径>`，随后 `npm run verify` 做冒烟验证。
