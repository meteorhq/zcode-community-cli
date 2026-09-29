#!/usr/bin/env node
/**
 * Build the standalone zcode-oss-cli package from a local checkout of the
 * open-source ZCode repository (https://github.com/zalo/zcode style monorepo).
 *
 * What this does:
 *  1. Build the CLI bundle (`dist/zcode.cjs`) and its dependency packages
 *     inside the source repo, using the same commands as upstream
 *     (`turbo run build` + `node scripts/build.mjs --desktop-agent`).
 *  2. Stage the runtime artifacts into this package's `dist/`:
 *     zcode.cjs, provider config, third-party notices.
 *  3. Vendor the runtime-resolved `@zcode/*` workspace packages (tui and its
 *     workspace deps) under `dist/node_modules/@zcode/`. The bundle keeps
 *     `@zcode/tui` external and loads it through dynamic import at runtime,
 *     so those packages must ship next to the bundle exactly like they sit
 *     in the source workspace's node_modules.
 *  4. Record provenance in dist/BUILD_INFO.json.
 *
 * Usage:
 *   node scripts/build-package.mjs [--source <path>] [--no-build]
 *
 * Source repo resolution order: --source flag, ZCODE_SOURCE env,
 * ../ZCode, ../../Projects/ZCode.
 */
import { execFileSync } from "node:child_process";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import process from "node:process";

const packageRoot = resolve(import.meta.dirname, "..");
const distRoot = join(packageRoot, "dist");

const log = (message) => console.log(`[build-package] ${message}`);
const run = (command, args, options = {}) =>
  execFileSync(command, args, { stdio: "inherit", ...options });

function parseArgs(argv) {
  const args = { source: undefined, build: true };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--source") {
      args.source = argv[index + 1];
      index += 1;
    } else if (argv[index] === "--no-build") {
      args.build = false;
    } else {
      throw new Error(`Unknown argument: ${argv[index]}`);
    }
  }
  return args;
}

function resolveSourcePath(args) {
  const candidates = [
    args.source,
    process.env.ZCODE_SOURCE,
    "../ZCode",
    "../../Projects/ZCode",
  ].filter(Boolean);
  for (const candidate of candidates) {
    const path = resolve(packageRoot, candidate);
    if (existsSync(join(path, "apps/zcode-cli/package.json"))) return path;
  }
  throw new Error(
    `Cannot locate the ZCode source repo (need apps/zcode-cli). Pass --source <path> or set ZCODE_SOURCE.`,
  );
}

/**
 * Resolve a `pnpm` runner. The user's machine may not expose pnpm on PATH
 * (e.g. when pnpm is managed by mise). Fall back to a corepack shim pinned
 * to the version declared in the source repo.
 */
function resolvePnpmRunner(sourceRoot) {
  const sourceManifest = JSON.parse(
    readFileSync(join(sourceRoot, "apps/zcode-cli/package.json"), "utf8"));
  const pnpmVersion = sourceManifest.packageManager.split("@")[1];

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
    mkdir(shimDir, { recursive: true });
    const shim = join(shimDir, "pnpm");
    writeFile(
      shim,
      `#!/bin/sh\nexec corepack pnpm@${pnpmVersion} "$@"\n`,
      { mode: 0o755 },
    );
    return { command: "pnpm", prefix: [], envPath: shimDir };
  }
  throw new Error("Neither pnpm nor corepack is available on PATH.");
}

function buildInSourceRepo(sourceRoot) {
  const { command, prefix, envPath } = resolvePnpmRunner(sourceRoot);
  const env = envPath
    ? { ...process.env, PATH: `${envPath}:${process.env.PATH}` }
    : process.env;

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

async function writeBuildInfo(sourceRoot) {
  const commit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: sourceRoot,
    encoding: "utf8",
  }).trim();
  const upstream = JSON.parse(await readFile(join(sourceRoot, "apps/zcode-cli/package.json"), "utf8"));
  const info = {
    sourceRepository: "https://github.com/zai-org/ZCode",
    sourceCommit: commit,
    upstreamZcodeCliVersion: upstream.version,
    buildMode: "desktop-agent",
    buildDate: new Date().toISOString(),
    nodeVersion: process.version,
  };
  await writeFile(join(distRoot, "BUILD_INFO.json"), `${JSON.stringify(info, null, 2)}\n`);

  const own = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  if (own.version !== upstream.version) {
    log(
      `WARNING: package version ${own.version} != upstream apps/zcode-cli version ${upstream.version}. ` +
        "Update package.json version to stay aligned.",
    );
  }
}

const args = parseArgs(process.argv.slice(2));
const sourceRoot = resolveSourcePath(args);
log(`Source repo: ${sourceRoot}`);
if (args.build) {
  buildInSourceRepo(sourceRoot);
} else {
  log("Skipping source build (--no-build)");
}
await stageDist(sourceRoot);
await writeBuildInfo(sourceRoot);
log("Done. Run `npm install` (once) and `npm run verify` to smoke-test the package.");
