#!/usr/bin/env node
// Synchronize @gaunt-sloth/* package versions across the monorepo.
//
// `npm run release:bump`                — patch-increment core's version, then sync everything
// `npm run release:bump -- minor`       — increment (patch | minor | major), then sync
// `npm run release:bump -- 0.0.7`       — set 0.0.7 (re-syncs without bumping if already current), then sync
// `npm run release:bump-and-commit`     — same, then refresh package-lock.json and git-commit
//
// SYNCED packages (core, agent, review) all carry the same version and
// pin each other exactly; packages/core/package.json is the source of truth.
// The user-facing `gaunt-sloth` CLI (dir: packages/assistant) keeps its own
// version — only its dep pins on the synced set are rewritten.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const SCOPE = '@gaunt-sloth';
const SYNCED = ['core', 'agent', 'review'];

const args = process.argv.slice(2);
const commit = args.includes('--commit');
const spec = args.find((a) => a !== '--commit') ?? 'patch';
if (!['patch', 'minor', 'major'].includes(spec) && !/^\d+\.\d+\.\d+(?:-[\w.]+)?$/.test(spec)) {
  console.error(`Bad version: ${spec}. Expected patch | minor | major | MAJOR.MINOR.PATCH[-prerelease].`);
  process.exit(1);
}

function readPkg(rel) {
  return JSON.parse(readFileSync(join(ROOT, rel), 'utf8'));
}
function writePkg(rel, obj) {
  writeFileSync(join(ROOT, rel), JSON.stringify(obj, null, 2) + '\n');
}

// Same increment semantics as `npm version` (semver.inc): a prerelease is
// "released" by the increment rather than stacked on top of it.
function increment(version, release) {
  const m = version.match(/^(\d+)\.(\d+)\.(\d+)(-[\w.]+)?$/);
  if (!m) {
    console.error(`Cannot increment non-semver core version: ${version}`);
    process.exit(1);
  }
  const [major, minor, patch] = m.slice(1, 4).map(Number);
  const pre = Boolean(m[4]);
  switch (release) {
    case 'major':
      return pre && minor === 0 && patch === 0 ? `${major}.0.0` : `${major + 1}.0.0`;
    case 'minor':
      return pre && patch === 0 ? `${major}.${minor}.0` : `${major}.${minor + 1}.0`;
    case 'patch':
      return pre ? `${major}.${minor}.${patch}` : `${major}.${minor}.${patch + 1}`;
  }
}

const coreVersion = readPkg('packages/core/package.json').version;
const target = ['patch', 'minor', 'major'].includes(spec) ? increment(coreVersion, spec) : spec;
console.log(`Syncing ${SCOPE}/* to ${target} (source of truth: packages/core)`);

function rewriteSyncedDeps(deps) {
  if (!deps) return false;
  let changed = false;
  for (const k of Object.keys(deps)) {
    if (!k.startsWith(`${SCOPE}/`)) continue;
    const internal = k.slice(SCOPE.length + 1);
    if (SYNCED.includes(internal) && deps[k] !== target) {
      deps[k] = target;
      changed = true;
    }
  }
  return changed;
}

for (const name of SYNCED) {
  const path = `packages/${name}/package.json`;
  const pkg = readPkg(path);
  const before = pkg.version;
  pkg.version = target;
  rewriteSyncedDeps(pkg.dependencies);
  rewriteSyncedDeps(pkg.peerDependencies);
  writePkg(path, pkg);
  console.log(`  ${name.padEnd(8)} ${before} → ${target}`);
}

const assistantPath = 'packages/assistant/package.json';
const assistant = readPkg(assistantPath);
const assistantChanged = rewriteSyncedDeps(assistant.dependencies);
if (assistantChanged) {
  writePkg(assistantPath, assistant);
  console.log(`  assistant deps → ${target} (own version ${assistant.version} unchanged)`);
} else {
  console.log(`  assistant deps already at ${target}`);
}

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
    ...SYNCED.map((name) => `packages/${name}/package.json`),
    assistantPath,
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
    execFileSync('git', ['commit', '-m', `Release ${SCOPE}/* ${target}`, '--', ...files], {
      cwd: ROOT,
      stdio: 'inherit',
    });
  }
}
