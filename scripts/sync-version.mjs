#!/usr/bin/env node
/**
 * Track a new upstream ZCode release: point upstream.json at the given tag
 * and sync this package's version with the upstream apps/zcode-cli version.
 *
 * Usage:
 *   node scripts/sync-version.mjs <upstream-tag>     e.g. v3.15.0
 *
 * What it does:
 *  1. Fetches apps/zcode-cli/package.json at that tag from GitHub and reads
 *     the upstream CLI version.
 *  2. Updates `ref` in upstream.json and `version` in package.json, then
 *     refreshes package-lock.json.
 *  3. Warns if that version was already published to npm (you then need a
 *     packaging-only `-N` suffix instead).
 *
 * Afterwards: commit, push (CI validates), then run the Release workflow.
 */
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import process from "node:process";

const packageRoot = resolve(import.meta.dirname, "..");
const log = (message) => console.log(`[sync-version] ${message}`);

const tag = process.argv[2];
if (!tag || tag.startsWith("-")) {
  console.error("Usage: node scripts/sync-version.mjs <upstream-tag>   e.g. v3.15.0");
  process.exit(1);
}

const upstreamConfig = JSON.parse(await readFile(join(packageRoot, "upstream.json"), "utf8"));
const repo = upstreamConfig.repository.replace(/^https:\/\/github\.com\//, "");
const cliManifestUrl = `https://raw.githubusercontent.com/${repo}/${tag}/apps/zcode-cli/package.json`;

log(`Fetching ${cliManifestUrl}`);
const response = await fetch(cliManifestUrl);
if (!response.ok) {
  console.error(`[sync-version] Cannot read apps/zcode-cli/package.json at ${tag}: HTTP ${response.status}. Does the tag exist?`);
  process.exit(1);
}
const upstreamVersion = (await response.json()).version;
if (!/^\d+\.\d+\.\d+/.test(upstreamVersion ?? "")) {
  console.error(`[sync-version] Unexpected upstream version: ${upstreamVersion}`);
  process.exit(1);
}

const registry = await fetch(`https://registry.npmjs.org/zcode-community-cli`).then((r) => r.json()).catch(() => undefined);
const published = registry?.versions ? Object.keys(registry.versions) : [];

const pkgPath = join(packageRoot, "package.json");
const pkg = JSON.parse(await readFile(pkgPath, "utf8"));

if (pkg.version === upstreamVersion && published.includes(upstreamVersion)) {
  log(`Upstream ${tag} still ships CLI ${upstreamVersion}, and ${upstreamVersion} is already on npm.`);
  log(`For a packaging-only republish, bump package.json version to ${upstreamVersion}-<N> manually.`);
}

pkg.version = upstreamVersion;
await writeFile(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
upstreamConfig.ref = tag;
await writeFile(join(packageRoot, "upstream.json"), `${JSON.stringify(upstreamConfig, null, 2)}\n`);

execFileSync("npm", ["install", "--package-lock-only", "--no-fund", "--no-audit"], {
  cwd: packageRoot,
  stdio: "inherit",
});

log(`Synced to upstream ${tag} (CLI version ${upstreamVersion}).`);
log("Next: commit + push (CI will validate), then run the Release workflow on GitHub.");
