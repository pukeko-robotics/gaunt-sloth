#!/usr/bin/env node
// Synchronize the Gaunt Sloth package versions across the monorepo.
//
// `npm run release:bump`                      — patch-increment core's version, then sync everything
// `npm run release:bump -- minor`             — increment (patch | minor | major | pre*) , then sync
// `npm run release:bump -- prerelease alpha`  — semver.inc with a preid, then sync
// `npm run release:bump -- 2.0.0-alpha.0`     — set an explicit version, then sync
// `npm run release:bump-and-commit -- ...`    — same, then refresh package-lock.json and git-commit
//
// LOCKED packages — all four carry the SAME version and pin each other exactly:
//   @gaunt-sloth/core, @gaunt-sloth/agent, @gaunt-sloth/review  (dirs: core/agent/review)
//   gaunt-sloth                                                  (dir:  app)
// packages/core/package.json is the source of truth for the version.
//
// The fat CLI's package NAME is `gaunt-sloth` (not @gaunt-sloth/app), so it
// is version-synced and has its @gaunt-sloth/* dep pins rewritten, but nothing
// cross-pins a (nonexistent) `@gaunt-sloth/app`.
//
// publishConfig.tag (the `latest`-hijack guard) is written into all four
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
const SYNCED = ['core', 'agent', 'review'];
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
  `Syncing all four packages to ${target} (source of truth: packages/core), ` +
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
  // package-lock.json records the workspace versions, so refresh it or the
  // next `npm ci` sees the lock and the package.jsons out of sync.
  console.log('Refreshing package-lock.json');
  execFileSync('npm', ['install', '--package-lock-only'], {
    cwd: ROOT,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });

  const files = [
    ...ALL_DIRS.map((name) => `packages/${name}/package.json`),
    'package-lock.json',
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
    execFileSync('git', ['commit', '-m', `Release ${target}`, '--', ...files], {
      cwd: ROOT,
      stdio: 'inherit',
    });
  }
}
