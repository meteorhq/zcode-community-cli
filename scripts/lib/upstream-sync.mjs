/**
 * Shared upstream-tracking logic used by sync-version.mjs (manual) and
 * check-upstream.mjs (scheduled CI auto-release).
 */
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const packageRoot = resolve(import.meta.dirname, "../..");

export const readUpstreamConfig = async () =>
  JSON.parse(await readFile(join(packageRoot, "upstream.json"), "utf8"));

export const readPackageManifest = async () =>
  JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));

/** Latest vMAJOR.MINOR.PATCH tag on the upstream remote (git ls-remote, no auth needed). */
export const fetchLatestTag = async (repositoryUrl) => {
  const output = execFileSync("git", ["ls-remote", "--tags", repositoryUrl], {
    encoding: "utf8",
    timeout: 30_000,
  });
  const tags = output
    .split("\n")
    .map((line) => line.trim().split(/\s+/).at(-1) ?? "")
    .map((ref) => ref.replace(/^refs\/tags\//, ""))
    .filter((tag) => !tag.endsWith("^{}") && /^v\d+\.\d+\.\d+$/.test(tag));
  tags.sort(compareSemver);
  return tags.at(-1);
};

/** The upstream apps/zcode-cli version at a given tag. */
export const fetchCliVersionAt = async (repositoryUrl, tag) => {
  const repo = repositoryUrl.replace(/^https:\/\/github\.com\//, "");
  const url = `https://raw.githubusercontent.com/${repo}/${tag}/apps/zcode-cli/package.json`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Cannot read apps/zcode-cli/package.json at ${tag}: HTTP ${response.status}`);
  }
  const version = (await response.json()).version;
  if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version ?? "")) {
    throw new Error(`Unexpected upstream version at ${tag}: ${version}`);
  }
  return version;
};

/** Versions of zcode-community-cli already published to the npm registry. */
export const fetchPublishedVersions = async (packageName) => {
  const registry = await fetch(`https://registry.npmjs.org/${packageName}`)
    .then((response) => (response.ok ? response.json() : undefined))
    .catch(() => undefined);
  return registry?.versions ? Object.keys(registry.versions) : [];
};

/**
 * Publish version per policy: mirror the upstream version; if that exact
 * version is already on npm (new tag shipping the same CLI version, or a
 * republish), append the next free prerelease suffix -1, -2, ...
 */
export const computePublishVersion = (upstreamVersion, publishedVersions) => {
  if (!publishedVersions.includes(upstreamVersion)) return upstreamVersion;
  const prefix = `${upstreamVersion}-`;
  const used = publishedVersions
    .filter((version) => version.startsWith(prefix))
    .map((version) => Number(version.slice(prefix.length)))
    .filter((n) => Number.isInteger(n) && n > 0);
  const next = (used.length > 0 ? Math.max(...used) : 0) + 1;
  return `${upstreamVersion}-${next}`;
};

/** Plain semver comparison over vMAJOR.MINOR.PATCH[-pre] strings; -1 / 0 / 1. */
export const compareSemver = (a, b) => {
  const parse = (value) => {
    const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([\w.]+))?$/.exec(value);
    if (!match) return undefined;
    return { numbers: match.slice(1, 4).map(Number), pre: match[4] };
  };
  const left = parse(a);
  const right = parse(b);
  if (!left || !right) return 0;
  for (let index = 0; index < 3; index += 1) {
    if (left.numbers[index] !== right.numbers[index]) {
      return left.numbers[index] < right.numbers[index] ? -1 : 1;
    }
  }
  // A release outranks its own prereleases: 1.2.3 > 1.2.3-1.
  if (left.pre && right.pre) return left.pre < right.pre ? -1 : left.pre > right.pre ? 1 : 0;
  if (left.pre) return -1;
  if (right.pre) return 1;
  return 0;
};

/** Persist the new upstream tag + publish version into upstream.json / package.json / lockfile. */
export const applySync = async ({ tag, version }) => {
  const upstreamPath = join(packageRoot, "upstream.json");
  const packagePath = join(packageRoot, "package.json");

  const upstreamConfig = await readUpstreamConfig();
  upstreamConfig.ref = tag;
  await writeFile(upstreamPath, `${JSON.stringify(upstreamConfig, null, 2)}\n`);

  const pkg = await readPackageManifest();
  pkg.version = version;
  await writeFile(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);

  execFileSync("npm", ["install", "--package-lock-only", "--no-fund", "--no-audit"], {
    cwd: packageRoot,
    stdio: "inherit",
  });
};
