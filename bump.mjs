#!/usr/bin/env node
// Synchronize the Gaunt Sloth package versions across the monorepo.
//
// `npm run release:bump`                      — patch-increment core's version, then sync everything
// `npm run release:bump -- minor`             — increment (patch | minor | major | pre*) , then sync
// `npm run release:bump -- prerelease alpha`  — semver.inc with a preid, then sync
// `npm run release:bump -- 2.0.0-alpha.0`     — set an explicit version, then sync
// `npm run release:bump-and-commit -- ...`    — same, then refresh pnpm-lock.yaml and git-commit
//
// LOCKED packages — all five carry the SAME version and pin each other exactly:
//   @gaunt-sloth/core, @gaunt-sloth/agent, @gaunt-sloth/review, @gaunt-sloth/batch
//     (dirs: core/agent/review/batch)
//   gaunt-sloth                                                  (dir:  app)
// packages/core/package.json is the source of truth for the version.
//
// The fat CLI's package NAME is `gaunt-sloth` (not @gaunt-sloth/app), so it
// is version-synced and has its @gaunt-sloth/* dep pins rewritten, but nothing
// cross-pins a (nonexistent) `@gaunt-sloth/app`.
//
// INDEPENDENTLY VERSIONED plugins — NOT synced here: the
// @gaunt-sloth/eval-reporter-* plugin family (e.g. @gaunt-sloth/eval-reporter-junit,
// dir eval-reporter-junit) is versioned on its own track and bumped by hand when
// the plugin itself changes. It is PUBLISHED and git-TAGGED alongside the locked
// set (see publish-all.sh / tag-packages.sh) but is deliberately absent from SYNCED
// / ALL_DIRS below, so this script never rewrites its version. The app hard-deps it
// via `workspace:*`; rewriteSyncedDeps leaves that specifier untouched (the
// `workspace:` skip), so the sync does not disturb the plugin dep either.
//
// publishConfig.tag (the `latest`-hijack guard) is written into all five
// package.jsons, derived from the new version: a prerelease (e.g. 2.0.0-alpha.0)
// gets its preid (alpha/beta/rc) as the tag; a stable version gets `latest`. This
// keeps publishConfig.tag consistent with the version's channel, so even a bare
// `npm publish` can't move `latest` to a prerelease.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import semver from 'semver';

const ROOT = dirname(fileURLToPath(import.meta.url));
const SCOPE = '@gaunt-sloth';
// Synced library packages (scoped). They cross-pin each other exactly.
const SYNCED = ['core', 'agent', 'review', 'batch'];
// The fat CLI: dir `app`, but its package name is `gaunt-sloth`.
const APP_DIR = 'app';
// Every package that carries the locked version + publishConfig.tag.
const ALL_DIRS = [...SYNCED, APP_DIR];

const RELEASE_TYPES = [
  'patch',
  'minor',
  'major',
  'prepatch',
  'preminor',
  'premajor',
  'prerelease',
];
const PREIDS = ['alpha', 'beta', 'rc'];

// Drop our own `--commit` flag and any bare `--` arg-separator. pnpm forwards
// the `--` from `pnpm run <script> -- <args>` literally into argv (npm strips
// it), so without this a `--` would be parsed as the version spec.
const args = process.argv.slice(2).filter((a) => a !== '--commit' && a !== '--');
const commit = process.argv.slice(2).includes('--commit');

// Arg shapes:
//   (nothing)                  -> patch
//   <releaseType> [preid]      -> semver.inc(current, releaseType, preid)
//   <explicit version>         -> set verbatim (e.g. 2.0.0-alpha.0)
const spec = args[0] ?? 'patch';
const preid = args[1];

const isReleaseType = RELEASE_TYPES.includes(spec);
const isExplicit = semver.valid(spec) !== null;

if (!isReleaseType && !isExplicit) {
  console.error(
    `Bad version: ${spec}. Expected one of [${RELEASE_TYPES.join(' | ')}] ` +
      `or an explicit MAJOR.MINOR.PATCH[-prerelease].`
  );
  process.exit(1);
}
if (preid !== undefined && !PREIDS.includes(preid)) {
  console.error(`Bad preid: ${preid}. Expected one of [${PREIDS.join(' | ')}].`);
  process.exit(1);
}
if (preid !== undefined && isExplicit) {
  console.error(`A preid (${preid}) is only valid with a release type, not an explicit version.`);
  process.exit(1);
}

function readPkg(rel) {
  return JSON.parse(readFileSync(join(ROOT, rel), 'utf8'));
}
function writePkg(rel, obj) {
  writeFileSync(join(ROOT, rel), JSON.stringify(obj, null, 2) + '\n');
}

const coreVersion = readPkg('packages/core/package.json').version;
const target = isReleaseType ? semver.inc(coreVersion, spec, preid) : spec;
if (!target || semver.valid(target) === null) {
  console.error(`Could not compute a valid target version from "${spec}" (core: ${coreVersion}).`);
  process.exit(1);
}

// Derive the npm dist-tag / publishConfig.tag from the version's channel:
// a prerelease -> its preid (alpha/beta/rc); a stable version -> latest.
function deriveTag(version) {
  const pre = semver.prerelease(version);
  if (!pre) return 'latest';
  const id = pre.find((p) => typeof p === 'string');
  return id ?? 'latest';
}
const distTag = deriveTag(target);

console.log(
  `Syncing all five packages to ${target} (source of truth: packages/core), ` +
    `publishConfig.tag = ${distTag}`
);

function rewriteSyncedDeps(deps) {
  if (!deps) return false;
  let changed = false;
  for (const k of Object.keys(deps)) {
    if (!k.startsWith(`${SCOPE}/`)) continue;
    const internal = k.slice(SCOPE.length + 1);
    // Cross-deps use pnpm's `workspace:` protocol (workspace:*). Those are
    // version-agnostic and pnpm rewrites them to the concrete version at
    // pack/publish time, so leave them untouched — overwriting them with a
    // literal version would break local workspace resolution.
    if (typeof deps[k] === 'string' && deps[k].startsWith('workspace:')) continue;
    if (SYNCED.includes(internal) && deps[k] !== target) {
      deps[k] = target;
      changed = true;
    }
  }
  return changed;
}

// Write publishConfig.tag, preserving any other publishConfig keys.
function setPublishTag(pkg) {
  const current = pkg.publishConfig ?? {};
  if (current.tag === distTag) return false;
  pkg.publishConfig = { ...current, tag: distTag };
  return true;
}

for (const name of SYNCED) {
  const path = `packages/${name}/package.json`;
  const pkg = readPkg(path);
  const before = pkg.version;
  pkg.version = target;
  rewriteSyncedDeps(pkg.dependencies);
  rewriteSyncedDeps(pkg.peerDependencies);
  setPublishTag(pkg);
  writePkg(path, pkg);
  console.log(`  ${name.padEnd(9)} ${before} → ${target}  (tag ${distTag})`);
}

// The fat CLI (gaunt-sloth) is now version-locked too.
const appPath = `packages/${APP_DIR}/package.json`;
const app = readPkg(appPath);
const appBefore = app.version;
app.version = target;
rewriteSyncedDeps(app.dependencies);
rewriteSyncedDeps(app.peerDependencies);
setPublishTag(app);
writePkg(appPath, app);
console.log(`  ${'gaunt-sloth'.padEnd(9)} ${appBefore} → ${target}  (tag ${distTag})`);

if (commit) {
  // pnpm-lock.yaml records the workspace importers, so refresh it or a later
  // `pnpm install --frozen-lockfile` sees the lock and the package.jsons out of
  // sync. This is a pnpm workspace (workspace:* cross-deps, no package-lock.json)
  // — refreshing must go through pnpm; `npm install --package-lock-only` cannot
  // resolve the workspace:* protocol and crashes ("Cannot read properties of
  // null (reading 'matches')"). `--lockfile-only` updates the lock without
  // touching node_modules, and is a no-op when nothing in the lock changed.
  console.log('Refreshing pnpm-lock.yaml');
  execFileSync('pnpm', ['install', '--lockfile-only'], {
    cwd: ROOT,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });

  const files = [
    ...ALL_DIRS.map((name) => `packages/${name}/package.json`),
    'pnpm-lock.yaml',
  ];
  const status = execFileSync('git', ['status', '--porcelain', '--', ...files], {
    cwd: ROOT,
    encoding: 'utf8',
  }).trim();
  if (!status) {
    console.log('Everything already committed at this version — nothing to commit.');
  } else {
    execFileSync('git', ['add', '--', ...files], { cwd: ROOT, stdio: 'inherit' });
    // Pathspec-limited commit: only the bump files go in, so anything else the
    // user had staged stays staged instead of being swept into the release.
    // Model B: this is the POST-bump — main now carries the NEXT version to
    // publish, so it's the start of that version's dev cycle, NOT its release
    // (the release/tag/publish for the prior version already happened). Word it
    // so the history doesn't read as if `target` has shipped.
    execFileSync('git', ['commit', '-m', `chore(release): start ${target} development cycle`, '--', ...files], {
      cwd: ROOT,
      stdio: 'inherit',
    });
  }
}
