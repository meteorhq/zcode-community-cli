#!/usr/bin/env node
/**
 * Build the standalone zcode-community-cli package from the open-source ZCode
 * repository (https://github.com/zai-org/ZCode).
 *
 * What this does:
 *  1. Resolve the ZCode source repo: --source flag, ZCODE_SOURCE env, a local
 *     checkout next to this repo, or — as a fully self-contained fallback —
 *     a shallow clone of the pinned ref from upstream.json into .upstream/
 *     (this is what CI uses; dependencies are installed automatically).
 *  2. Build the CLI bundle (`dist/zcode.cjs`) and its dependency packages
 *     inside the source repo, using the same commands as upstream
 *     (`turbo run build` + `node scripts/build.mjs --desktop-agent`).
 *  3. Stage the runtime artifacts into this package's `dist/`:
 *     zcode.cjs, provider config, third-party notices.
 *  4. Vendor the runtime-resolved `@zcode/*` workspace packages (tui and its
 *     workspace deps) under `dist/node_modules/@zcode/`. The bundle keeps
 *     `@zcode/tui` external and loads it through dynamic import at runtime,
 *     so those packages must ship next to the bundle exactly like they sit
 *     in the source workspace's node_modules.
 *  5. Record provenance in dist/BUILD_INFO.json.
 *
 * Usage:
 *   node scripts/build-package.mjs [--source <path>] [--no-build]
 *                                  [--upstream] [--refresh] [--upstream-ref <ref>]
 */
import { execFileSync } from "node:child_process";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import process from "node:process";

const packageRoot = resolve(import.meta.dirname, "..");
const distRoot = join(packageRoot, "dist");
const upstreamConfig = JSON.parse(readFileSync(join(packageRoot, "upstream.json"), "utf8"));

const log = (message) => console.log(`[build-package] ${message}`);
const run = (command, args, options = {}) =>
  execFileSync(command, args, { stdio: "inherit", ...options });

function parseArgs(argv) {
  const args = {
    source: undefined,
    build: true,
    upstream: false,
    refresh: false,
    upstreamRef: undefined,
  };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--source") {
      args.source = argv[index + 1];
      index += 1;
    } else if (argv[index] === "--no-build") {
      args.build = false;
    } else if (argv[index] === "--upstream") {
      args.upstream = true;
    } else if (argv[index] === "--refresh") {
      args.refresh = true;
    } else if (argv[index] === "--upstream-ref") {
      args.upstreamRef = argv[index + 1];
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${argv[index]}`);
    }
  }
  return args;
}

const isSourceRepo = (path) => existsSync(join(path, "apps/zcode-cli/package.json"));

/**
 * Decide where the ZCode source comes from. Returns the source root; when the
 * upstream clone path is taken and dependencies are not installed yet, the
 * caller must run installSourceDeps before building.
 */
function ensureSourceRepo(args) {
  const explicit = args.source ?? process.env.ZCODE_SOURCE;
  if (explicit) {
    const path = resolve(packageRoot, explicit);
    if (!isSourceRepo(path)) throw new Error(`--source ${explicit} is not a ZCode checkout`);
    return { root: path, needsInstall: !existsSync(join(path, "node_modules")) };
  }

  if (!args.upstream) {
    const local = ["../ZCode", "../../Projects/ZCode"]
      .map((candidate) => resolve(packageRoot, candidate))
      .find(isSourceRepo);
    if (local) return { root: local, needsInstall: !existsSync(join(local, "node_modules")) };
  }

  const ref = args.upstreamRef ?? upstreamConfig.ref;
  if (/^[0-9a-f]{7,40}$/.test(ref)) {
    throw new Error("Pin upstream.json to a tag or branch; shallow clone cannot fetch arbitrary commits");
  }
  const cacheDir = join(packageRoot, ".upstream/ZCode");
  // The cache must match the pinned ref exactly: a stale clone at an old tag
  // would silently build outdated artifacts under the new ref's name.
  const refMarker = join(packageRoot, ".upstream/cloned-ref");
  const cachedRef = existsSync(refMarker) ? readFileSync(refMarker, "utf8").trim() : undefined;
  if (args.refresh || !isSourceRepo(cacheDir) || cachedRef !== ref) {
    log(`Cloning ${upstreamConfig.repository}@${ref} (shallow) into ${cacheDir}`);
    rmSync(join(packageRoot, ".upstream"), { recursive: true, force: true });
    run("git", ["clone", "--depth", "1", "--branch", ref, upstreamConfig.repository, cacheDir]);
    writeFileSync(refMarker, ref);
    return { root: cacheDir, needsInstall: true, upstreamRef: ref };
  }
  log(`Reusing upstream clone at ${cacheDir} (${ref}; pass --refresh to re-clone)`);
  return {
    root: cacheDir,
    needsInstall: !existsSync(join(cacheDir, "node_modules")),
    upstreamRef: ref,
  };
}

/**
 * Resolve a `pnpm` runner. The build machine may not expose pnpm on PATH
 * (e.g. when pnpm is managed by mise). Fall back to a corepack shim pinned
 * to the version declared in the source repo's root manifest.
 */
function resolvePnpmRunner(sourceRoot) {
  const rootManifest = JSON.parse(readFileSync(join(sourceRoot, "package.json"), "utf8"));
  const pnpmVersion = rootManifest.packageManager.split("@")[1];

  const lookup = (command) => {
    try {
      execFileSync(command, ["--version"], { stdio: "pipe", encoding: "utf8" });
      return { command, prefix: [] };
    } catch {
      return undefined;
    }
  };

  const direct = lookup("pnpm");
  if (direct) return direct;

  const corepack = lookup("corepack");
  if (corepack) {
    const shimDir = join(packageRoot, ".corepack-shim");
    mkdirSync(shimDir, { recursive: true });
    const shim = join(shimDir, "pnpm");
    writeFileSync(
      shim,
      `#!/bin/sh\nexec corepack pnpm@${pnpmVersion} "$@"\n`,
      { mode: 0o755 },
    );
    return { command: "pnpm", prefix: [], envPath: shimDir };
  }
  throw new Error("Neither pnpm nor corepack is available on PATH.");
}

/** Install the source repo's workspace dependencies (fresh upstream clone only). */
function installSourceDeps(sourceRoot) {
  const { command, prefix, envPath } = resolvePnpmRunner(sourceRoot);
  const env = envPath
    ? { ...process.env, PATH: `${envPath}:${process.env.PATH}` }
    : process.env;
  log("Installing source repo dependencies (pnpm install --frozen-lockfile)");
  run(command, [...prefix, "install", "--frozen-lockfile"], { cwd: sourceRoot, env });
}

function buildInSourceRepo(sourceRoot) {
  const { command, prefix, envPath } = resolvePnpmRunner(sourceRoot);
  const baseEnv = envPath
    ? { ...process.env, PATH: `${envPath}:${process.env.PATH}` }
    : process.env;
  // Pin the built-in provider config to the source tree's committed copy.
  // Without this, local builds inherit the installed ZCode Desktop app's
  // runtime config path (~/.zcode/.../<app version>/...), whose schema can be
  // newer than the pinned source and fail build-time validation. CI runners
  // have no such config and already build from the repo copy.
  const env = {
    ...baseEnv,
    ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: join(sourceRoot, "config/provider/zcode-builtin.json"),
  };
  log(`Building dependency packages (turbo) in ${sourceRoot}`);
  run(
    command,
    [
      ...prefix,
      "exec",
      "turbo",
      "--skip-infer",
      "--cwd",
      "apps/zcode-cli",
      "run",
      "build",
      "--filter=!@zcode/cli",
      "--force",
    ],
    { cwd: sourceRoot, env },
  );

  log("Building the CLI bundle (desktop-agent mode: minified, no sourcemap)");
  run(command, [...prefix, "exec", "node", "scripts/build.mjs", "--desktop-agent"], {
    cwd: join(sourceRoot, "apps/zcode-cli/packages/cli"),
    env,
  });
}

/**
 * Strip a workspace manifest down to what runtime resolution needs.
 * Dependency fields are dropped on purpose: vendored packages resolve their
 * npm deps (zod, react, ...) by walking up to this package's root node_modules.
 */
function sanitizeManifest(manifest) {
  const clean = {
    name: manifest.name,
    version: manifest.version ?? "0.0.0",
    private: true,
  };
  if (manifest.type) clean.type = manifest.type;
  if (manifest.main) clean.main = manifest.main;
  if (manifest.exports) {
    const stripTypes = (node) => {
      if (Array.isArray(node)) return node.map(stripTypes);
      if (node && typeof node === "object") {
        const result = {};
        for (const [key, value] of Object.entries(node)) {
          if (key === "types" || key === "typings") continue;
          result[key] = stripTypes(value);
        }
        return result;
      }
      return node;
    };
    clean.exports = stripTypes(manifest.exports);
  }
  return clean;
}

/** Copy `from` into `to`, keeping only directories, JS and TS files. */
async function copyCode(from, to, { keepTs = false } = {}) {
  const keepFile = (file) =>
    file.endsWith(".js") || (keepTs && (file.endsWith(".ts") || file.endsWith(".tsx")));
  await cp(from, to, {
    recursive: true,
    filter: (source) => {
      if (source === from) return true;
      const base = basename(source);
      if (base === "node_modules" || base.startsWith(".")) return false;
      const info = existsSync(source) && statSyncSafe(source)?.isDirectory();
      if (info) return true;
      return keepFile(base);
    },
  });
}

const statSyncSafe = (path) => {
  try {
    return statSync(path);
  } catch {
    return undefined;
  }
};

/**
 * Workspace packages the CLI loads at runtime through the externalized
 * `@zcode/tui` import. Everything else is bundled into zcode.cjs.
 * Layout mirrors the source workspace: package dir + manifest + build output.
 */
const vendoredPackages = [
  { name: "@zcode/tui", dir: "apps/zcode-cli/packages/tui", copy: [{ from: "dist" }] },
  { name: "@zcode/shared", dir: "packages/shared", copy: [{ from: "src", keepTs: true }] },
  { name: "@zcode/contracts", dir: "apps/zcode-cli/packages/contracts", copy: [{ from: "dist" }] },
  { name: "@zcode/i18n", dir: "apps/zcode-cli/packages/i18n", copy: [{ from: "dist" }] },
  {
    name: "@zcode/model-option-map",
    dir: "packages/model-option-map",
    copy: [{ from: "src", keepTs: true }],
  },
];

async function stageDist(sourceRoot) {
  const cliDist = join(sourceRoot, "apps/zcode-cli/packages/cli/dist");
  await rm(distRoot, { recursive: true, force: true });
  await mkdir(distRoot, { recursive: true });

  log("Staging zcode.cjs, provider config and third-party notices");
  await cp(join(cliDist, "zcode.cjs"), join(distRoot, "zcode.cjs"));
  await cp(join(cliDist, "provider"), join(distRoot, "provider"), { recursive: true });
  await cp(join(cliDist, "THIRD-PARTY-NOTICES.md"), join(distRoot, "THIRD-PARTY-NOTICES.md"));

  log("Vendoring @zcode runtime packages into dist/node_modules");
  for (const pkg of vendoredPackages) {
    const pkgRoot = join(sourceRoot, pkg.dir);
    const target = join(distRoot, "node_modules/@zcode", pkg.name.slice("@zcode/".length));
    await mkdir(target, { recursive: true });
    const manifest = sanitizeManifest(JSON.parse(await readFile(join(pkgRoot, "package.json"), "utf8")));
    await writeFile(join(target, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    for (const entry of pkg.copy) {
      await copyCode(join(pkgRoot, entry.from), join(target, entry.from), { keepTs: entry.keepTs });
    }
    log(`  vendored ${pkg.name}`);
  }
}

async function writeBuildInfo(sourceRoot, upstreamRef) {
  const commit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: sourceRoot,
    encoding: "utf8",
  }).trim();
  const upstream = JSON.parse(await readFile(join(sourceRoot, "apps/zcode-cli/package.json"), "utf8"));
  const info = {
    sourceRepository: upstreamConfig.repository,
    sourceCommit: commit,
    upstreamRef: upstreamRef ?? null,
    upstreamZcodeCliVersion: upstream.version,
    buildMode: "desktop-agent",
    buildDate: new Date().toISOString(),
    nodeVersion: process.version,
  };
  await writeFile(join(distRoot, "BUILD_INFO.json"), `${JSON.stringify(info, null, 2)}\n`);

  const own = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  if (own.version !== upstream.version && !own.version.startsWith(`${upstream.version}-`)) {
    log(
      `WARNING: package version ${own.version} is neither ${upstream.version} nor ${upstream.version}-N. ` +
        "`npm run verify` will reject this; align package.json with the upstream CLI version.",
    );
  }
}

const args = parseArgs(process.argv.slice(2));
const source = ensureSourceRepo(args);
log(`Source repo: ${source.root}`);
if (source.needsInstall) {
  installSourceDeps(source.root);
}
if (args.build) {
  buildInSourceRepo(source.root);
} else {
  log("Skipping source build (--no-build)");
}
await stageDist(source.root);
await writeBuildInfo(source.root, source.upstreamRef);
log("Done. Run `npm install` (once) and `npm run verify` to smoke-test the package.");
