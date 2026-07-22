#!/usr/bin/env node
// Derive the npm dist-tag (publish CHANNEL) from a single package version string.
//
// This is the ONE source of truth for the dist-tag rule used by the publish path
// (publish-all.sh calls it per package). Extracting it out of inline bash makes
// the SHIPPED logic the TESTED logic — see packages/eval-reporter-teamcity/spec/distTag.spec.ts.
//
// NO `semver` dependency (REL-4): `semver` is only a *transitive* dep here, so a
// `require('semver')` could fail to hoist and, under publish-all.sh's `set -euo
// pipefail`, abort the whole publish before anything ships. This replicates the
// tiny inline string parse that used to live in publish-all.sh, EXACTLY (same
// fallbacks), so it is a drop-in replacement.
//
// The rule (identical to the old bash parse, and to bump.mjs's deriveTag for the
// synced set):
//   - stable version (no `-<prerelease>` suffix)      -> `latest`
//   - prerelease `X.Y.Z-<preid>.N`                    -> `<preid>`  (alpha | beta | rc)
//       <preid> = the substring after the FIRST `-`, up to the FIRST `.`
//   - a numeric-only or empty preid                   -> `latest`  (fallback)
//
// Why per-package (not one core-derived tag): the version-locked synced set
// (@gaunt-sloth/{core,agent,review,batch} + gaunt-sloth) all share core's
// version, so deriving from each package's OWN version yields the same channel
// for them — while the INDEPENDENTLY-versioned @gaunt-sloth/eval-reporter-* tier,
// a plain stable `0.x`, correctly derives `latest` instead of riding core's
// prerelease `alpha` tag (OPS-22).

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/**
 * @param {string} version a semver-ish version string, e.g. "2.0.0-alpha.24" or "0.1.1"
 * @returns {string} the npm dist-tag channel: "latest" for a stable version, else the preid
 */
export function deriveDistTag(version) {
  const v = String(version ?? '');
  const dash = v.indexOf('-');
  if (dash === -1) return 'latest'; // stable release
  let pre = v.slice(dash + 1); // 2.0.0-alpha.0 -> "alpha.0"
  const dot = pre.indexOf('.');
  if (dot !== -1) pre = pre.slice(0, dot); // -> "alpha"
  // A real channel is a non-empty, non-numeric identifier; else stay on latest.
  if (pre.length > 0 && !/^[0-9]+$/.test(pre)) return pre;
  return 'latest';
}

/**
 * Read the `version` field from a package.json at the given path.
 * @param {string} pkgPath
 * @returns {string}
 */
export function readVersion(pkgPath) {
  return JSON.parse(readFileSync(pkgPath, 'utf8')).version;
}

// CLI: print the derived dist-tag on stdout.
//   node scripts/dist-tag.mjs 2.0.0-alpha.24     -> alpha
//   node scripts/dist-tag.mjs 0.1.1              -> latest
//   node scripts/dist-tag.mjs --pkg packages/core/package.json
// Guarded so importing this module (e.g. from the vitest test) never runs the CLI.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  let version;
  if (args[0] === '--pkg') {
    if (!args[1]) {
      process.stderr.write('usage: dist-tag.mjs <version> | --pkg <path-to-package.json>\n');
      process.exit(2);
    }
    version = readVersion(args[1]);
  } else {
    version = args[0];
  }
  if (version === undefined || version === '') {
    process.stderr.write('usage: dist-tag.mjs <version> | --pkg <path-to-package.json>\n');
    process.exit(2);
  }
  process.stdout.write(deriveDistTag(version) + '\n');
}
