#!/usr/bin/env node
/**
 * Smoke-test the staged package before publishing.
 *
 *  1. `zcode.cjs --version` / `--licenses` must run (bundle is loadable).
 *  2. The vendored @zcode/tui ESM tree must be importable from dist/ —
 *     this exercises the whole runtime chain: vendored workspace packages,
 *     root npm deps (react, opentui, shiki) and Node's TS type stripping
 *     for @zcode/shared's source-only exports.
 *  3. `npm pack --dry-run` must include dist/zcode.cjs AND the vendored
 *     dist/node_modules/@zcode/* files in the tarball (npm historically has
 *     special handling for node_modules paths; this guards against silently
 *     publishing a broken package).
 *
 * Requires `npm install` to have run in this repo first.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { access, constants, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import process from "node:process";

const packageRoot = resolve(import.meta.dirname, "..");
const distRoot = join(packageRoot, "dist");

const failures = [];
const check = async (name, task) => {
  try {
    await task();
    console.log(`[verify] PASS ${name}`);
  } catch (error) {
    failures.push(name);
    console.error(`[verify] FAIL ${name}\n  ${error?.message ?? error}`);
  }
};

const runCli = (args) =>
  execFileSync(process.execPath, [join(distRoot, "zcode.cjs"), ...args], {
    encoding: "utf8",
    timeout: 60_000,
    // --licenses prints the full ~2MB third-party notices.
    maxBuffer: 16 * 1024 * 1024,
  });

const exists = (path) => access(path, constants.F_OK).then(() => true, () => false);

if (!existsSync(join(distRoot, "zcode.cjs"))) {
  console.error("[verify] dist/ is missing. Run `npm run build` first.");
  process.exit(1);
}

if (!existsSync(join(packageRoot, "node_modules"))) {
  console.error("[verify] node_modules is missing. Run `npm install` first.");
  process.exit(1);
}

await check("--version runs", async () => {
  const output = runCli(["--version"]);
  if (!/\d/.test(output)) throw new Error(`unexpected output: ${JSON.stringify(output)}`);
  console.log(`  ${output.trim()}`);
});

await check("--licenses runs", async () => {
  const output = runCli(["--licenses"]);
  if (!output.includes("Third-party notices")) throw new Error("licenses output looks wrong");
});

await check("vendored @zcode/tui imports", async () => {
  const tuiEntry = join(distRoot, "node_modules/@zcode/tui/dist/index.js");
  if (!existsSync(tuiEntry)) throw new Error(`${tuiEntry} not found`);
  const module = await import(pathToFileURL(tuiEntry).href);
  if (typeof module.runTui !== "function") {
    throw new Error(`runTui export missing: ${Object.keys(module).join(", ")}`);
  }
});

await check("npm pack tarball includes vendored runtime", async () => {
  const pack = spawnSync("npm", ["pack", "--dry-run"], {
    cwd: packageRoot,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (pack.status !== 0) throw new Error(`npm pack failed: ${pack.stderr}`);
  const output = pack.stdout + pack.stderr;
  const files = output
    .split("\n")
    .map((line) => line.trim().replace(/^npm notice\s+/, ""))
    // Listing lines look like "266B dist/BUILD_INFO.json": keep the path token.
    .map((line) => line.split(/\s+/).at(-1))
    .filter((line) => line.endsWith(".cjs") || line.endsWith(".js") || line.endsWith(".json"));
  const required = [
    "dist/zcode.cjs",
    "dist/provider/zcode-builtin.json",
    "dist/node_modules/@zcode/tui/dist/index.js",
    "dist/node_modules/@zcode/shared/package.json",
    "dist/BUILD_INFO.json",
  ];
  const missing = required.filter((file) => !files.includes(file));
  if (missing.length > 0) {
    throw new Error(`tarball is missing: ${missing.join(", ")}`);
  }
});

const buildInfo = JSON.parse(await readFile(join(distRoot, "BUILD_INFO.json"), "utf8"));
console.log(`[verify] built from ${buildInfo.sourceCommit} (upstream zcode-cli ${buildInfo.upstreamZcodeCliVersion})`);

await check("package version matches upstream policy", async () => {
  const own = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  const upstream = buildInfo.upstreamZcodeCliVersion;
  // Policy: mirror the upstream apps/zcode-cli version; packaging-only
  // republishes of the same upstream may append a prerelease suffix (-1, -2).
  const ok = own.version === upstream || own.version.startsWith(`${upstream}-`);
  if (!ok) {
    throw new Error(
      `package.json version ${own.version} must equal upstream ${upstream} or be ${upstream}-N`,
    );
  }
});

if (failures.length > 0) {
  console.error(`\n[verify] ${failures.length} check(s) failed: ${failures.join(", ")}`);
  process.exit(1);
}
console.log("[verify] all checks passed");
