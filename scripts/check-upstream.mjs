#!/usr/bin/env node
/**
 * Scheduled upstream check for the auto-release workflow.
 *
 * Compares the latest tag on the upstream ZCode remote with the ref pinned
 * in upstream.json. When a newer release tag exists:
 *   - reads the upstream apps/zcode-cli version at that tag,
 *   - computes the publish version per policy (mirror, or -N if already on npm),
 *   - writes upstream.json / package.json / package-lock.json.
 *
 * Emits GitHub Actions outputs (`updated`, `tag`, `version`) when running in
 * CI; always exits 0 when there is nothing to do so later steps can be skipped.
 *
 * Skips (logs and reports updated=false) when the upstream version would be a
 * downgrade of the current package version — that needs a human decision.
 */
import { appendFileSync } from "node:fs";
import process from "node:process";
import {
  applySync,
  compareSemver,
  computePublishVersion,
  fetchCliVersionAt,
  fetchLatestTag,
  fetchPublishedVersions,
  readPackageManifest,
  readUpstreamConfig,
} from "./lib/upstream-sync.mjs";

const log = (message) => console.log(`[check-upstream] ${message}`);

const setOutput = (name, value) => {
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
  }
};

const config = await readUpstreamConfig();
const latestTag = await fetchLatestTag(config.repository);
log(`Latest upstream tag: ${latestTag ?? "(none)"} · pinned: ${config.ref}`);
setOutput("updated", "false");

if (!latestTag) {
  log("No version tags found upstream; nothing to do.");
} else if (latestTag === config.ref) {
  log("Already tracking the latest upstream release.");
} else {
  const upstreamVersion = await fetchCliVersionAt(config.repository, latestTag);
  const pkg = await readPackageManifest();
  if (compareSemver(upstreamVersion, pkg.version) < 0) {
    log(
      `Upstream ${latestTag} ships CLI ${upstreamVersion}, lower than current package ` +
        `${pkg.version} — possible revert upstream; skipping auto-release.`,
    );
  } else {
    const published = await fetchPublishedVersions(pkg.name);
    const version = computePublishVersion(upstreamVersion, published);
    log(`New upstream release ${latestTag} → publishing ${pkg.name}@${version}`);
    await applySync({ tag: latestTag, version });
    setOutput("updated", "true");
    setOutput("tag", latestTag);
    setOutput("version", version);
  }
}
