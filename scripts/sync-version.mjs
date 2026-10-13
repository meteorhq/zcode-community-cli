#!/usr/bin/env node
/**
 * Track a new upstream ZCode release manually: point upstream.json at the
 * given tag and set this package's version per policy (mirror the upstream
 * apps/zcode-cli version; if already on npm, append the next -N suffix).
 *
 * Usage:
 *   node scripts/sync-version.mjs <upstream-tag>     e.g. v3.15.0
 *
 * Afterwards: commit, push (CI validates), then run the Release workflow.
 * For hands-off tracking use the scheduled Auto-release workflow instead.
 */
import process from "node:process";
import {
  applySync,
  computePublishVersion,
  fetchCliVersionAt,
  fetchPublishedVersions,
  readPackageManifest,
  readUpstreamConfig,
} from "./lib/upstream-sync.mjs";

const log = (message) => console.log(`[sync-version] ${message}`);

const tag = process.argv[2];
if (!tag || tag.startsWith("-")) {
  console.error("Usage: node scripts/sync-version.mjs <upstream-tag>   e.g. v3.15.0");
  process.exit(1);
}

const config = await readUpstreamConfig();
const pkg = await readPackageManifest();

const upstreamVersion = await fetchCliVersionAt(config.repository, tag).catch((error) => {
  console.error(`[sync-version] ${error.message}. Does the tag exist?`);
  process.exit(1);
});
const published = await fetchPublishedVersions(pkg.name);
const version = computePublishVersion(upstreamVersion, published);

await applySync({ tag, version });
log(
  published.includes(version)
    ? `Synced to ${tag}; publish version is ${version}` +
        ` (upstream ${upstreamVersion} already on npm).`
    : `Synced to ${tag} (CLI version ${version}).`,
);
log("Next: commit + push (CI will validate), then run the Release workflow on GitHub.");
