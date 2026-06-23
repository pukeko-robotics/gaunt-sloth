import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AllowlistStore,
  PersistedAllowlist,
  hasWideningFlag,
  matchesApproval,
} from '#src/tools/shell/allowlist.js';

describe('hasWideningFlag', () => {
  it('flags operation-widening flags (git clone transport override)', () => {
    expect(hasWideningFlag(['git', 'clone', '--upload-pack=evil', 'repo'])).toBe(true);
    expect(hasWideningFlag(['git', '-c', 'core.sshCommand=evil', 'clone', 'repo'])).toBe(true);
    expect(hasWideningFlag(['find', '.', '-exec', 'rm', '{}', ';'])).toBe(true);
  });

  it('does not flag benign flag variants', () => {
    expect(hasWideningFlag(['git', 'checkout', '-b', 'foo'])).toBe(false);
    expect(hasWideningFlag(['ls', '-la'])).toBe(false);
    expect(hasWideningFlag(['git', 'log', '--oneline'])).toBe(false);
  });
});

describe('matchesApproval (anti-injection)', () => {
  it('matches an approved prefix for a benign flag-variant', () => {
    const session = new AllowlistStore(['git checkout']);
    expect(matchesApproval('git checkout -b foo bar', { session })).toBe(true);
    expect(matchesApproval('git checkout main', { session })).toBe(true);
  });

  it('does NOT match a composed command even when the prefix is approved', () => {
    const session = new AllowlistStore(['git checkout']);
    // The classic injection: approved prefix riding a command separator.
    expect(matchesApproval('git checkout x; rm -rf /', { session })).toBe(false);
    expect(matchesApproval('git checkout x && rm -rf /', { session })).toBe(false);
    expect(matchesApproval('git checkout x | sh', { session })).toBe(false);
    expect(matchesApproval('git checkout $(rm -rf /)', { session })).toBe(false);
  });

  it('does NOT match a widening flag even when the prefix is approved', () => {
    const session = new AllowlistStore(['git clone']);
    expect(matchesApproval('git clone https://x/y.git', { session })).toBe(true);
    expect(matchesApproval('git clone --upload-pack=evil https://x/y.git', { session })).toBe(
      false
    );
  });

  it('does not match when the prefix is not approved', () => {
    const session = new AllowlistStore(['npm install']);
    expect(matchesApproval('git checkout main', { session })).toBe(false);
  });
});

describe('AllowlistStore (session scope)', () => {
  it('has/add set semantics', () => {
    const s = new AllowlistStore();
    expect(s.has('git checkout')).toBe(false);
    s.add('git checkout');
    expect(s.has('git checkout')).toBe(true);
    expect(s.list()).toEqual(['git checkout']);
  });
});

describe('PersistedAllowlist (always scope)', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gsloth-allowlist-'));
    file = join(dir, 'shell-allowlist.json');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('round-trips a prefix through the JSON file', () => {
    const a = new PersistedAllowlist(file);
    expect(a.has('git checkout')).toBe(false);
    a.add('git checkout');
    expect(a.has('git checkout')).toBe(true);

    // A fresh instance loads from disk.
    const b = new PersistedAllowlist(file);
    expect(b.has('git checkout')).toBe(true);

    const onDisk = JSON.parse(readFileSync(file, 'utf8'));
    expect(onDisk.version).toBe(1);
    expect(onDisk.prefixes).toContain('git checkout');
  });

  it('treats a missing file as empty', () => {
    const a = new PersistedAllowlist(join(dir, 'does-not-exist.json'));
    expect(a.list()).toEqual([]);
  });

  it('treats a corrupt file as empty (fail-closed on auto-approval)', () => {
    const corrupt = join(dir, 'corrupt.json');
    writeFileSync(corrupt, '{ not valid json', 'utf8');
    const a = new PersistedAllowlist(corrupt);
    expect(a.list()).toEqual([]);
  });
});
