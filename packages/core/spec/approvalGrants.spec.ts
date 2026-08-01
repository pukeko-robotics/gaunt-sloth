import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ApprovalGrantStore,
  PersistedApprovalGrants,
  shellGrantEntry,
  type ApprovalGrant,
} from '#src/core/approvals/grants.js';
import { resolveApprovalRules } from '#src/core/approvals/matcher.js';
import type { ApprovalEntry } from '#src/config/shell-policy.js';

/**
 * EXT-71 §3/§3.1/§6 — the store the escalation menu writes, and the v1 migration.
 *
 * Everything here that asks "does this grant cover that command" asks it through
 * `resolveApprovalRules`, because that is the only thing in the product that compares an entry to a
 * call. A test that inspected the stored object's shape instead would pass against a store holding
 * exactly the right entries and a gate that matched them wrongly.
 */

/** Does this set of entries, as an allow list, approve this command? */
const approves = (entries: readonly ApprovalEntry[], command: string): boolean =>
  resolveApprovalRules({ kind: 'shell', command }, { allow: entries, deny: [], escalate: [] })
    ?.action === 'allow';

const grantOf = (command: string, scope: 'session' | 'always' = 'always'): ApprovalGrant => ({
  entry: shellGrantEntry(command),
  grantedAt: '2026-08-02T00:00:00.000Z',
  scope,
});

describe('shellGrantEntry — what the menu writes (§3.1, §6)', () => {
  it('writes the command as a fully-explicit exact entry, never a prefix or a pattern', () => {
    expect(shellGrantEntry('npm test')).toEqual({
      type: 'shell',
      matcher: 'exact',
      pattern: 'npm test',
    });
  });

  /**
   * The entry is written in the form every comparison runs over (§3.1: spacing and quoting
   * spellings of one command are one command). Storing the raw string instead would mean the most
   * ordinary grant imaginable never matching the call that produced it — `"npm test\n"` is what a
   * tool argument routinely carries — which is a control offered and then refused.
   */
  it('normalizes, so the grant matches the very command that produced it', () => {
    const entry = shellGrantEntry('npm   test\n');
    expect(entry.pattern).toBe('npm test');
    expect(approves([entry], 'npm   test\n')).toBe(true);
    expect(approves([entry], 'npm test')).toBe(true);
    // …and it is still only that command.
    expect(approves([entry], 'npm test --watch')).toBe(false);
  });
});

describe('ApprovalGrantStore', () => {
  it('holds the metadata §3 requires a list to be able to show: what, when, at what scope', () => {
    const store = new ApprovalGrantStore();
    store.add(grantOf('npm test', 'session'));
    expect(store.list()).toEqual([
      {
        entry: { type: 'shell', matcher: 'exact', pattern: 'npm test' },
        grantedAt: '2026-08-02T00:00:00.000Z',
        scope: 'session',
      },
    ]);
  });

  it('de-duplicates by entry identity, and reports whether the grant was new', () => {
    const store = new ApprovalGrantStore();
    expect(store.add(grantOf('npm test'))).toBe(true);
    expect(store.add(grantOf('npm   test'))).toBe(false); // same command, same entry
    expect(store.add(grantOf('npm test --watch'))).toBe(true);
    expect(store.size()).toBe(2);
  });

  it('is per-instance, so concurrent sessions cannot stomp each other', () => {
    const a = new ApprovalGrantStore();
    const b = new ApprovalGrantStore();
    a.add(grantOf('npm test'));
    expect(b.size()).toBe(0);
  });
});

/**
 * EXT-55 — the headline consequence of the newline bug was that the most ordinary grant imaginable
 * (`always` on a plain `ls`) auto-approved `ls\nsudo rm -rf /etc` with no prompt, no model call and
 * no hardline block. Under the entry grammar two independent things stop it — the command does not
 * statically resolve, and it is not the granted string — but the GUARANTEE is what needs a test,
 * not the mechanism, so it is asserted here on the real path a grant is consulted through.
 */
describe('a grant cannot be extended with a separator (EXT-55)', () => {
  const separators: ReadonlyArray<readonly [string, string]> = [
    ['; (reference)', ';'],
    ['\\n', '\n'],
    ['\\r', '\r'],
    ['\\r\\n', '\r\n'],
    ['&&', '&&'],
  ];

  it.each(separators)('refuses a %s-separated payload riding a granted `ls`', (_label, sep) => {
    const entries = [shellGrantEntry('ls')];
    // Positive control: the granted command itself still auto-approves.
    expect(approves(entries, 'ls')).toBe(true);
    expect(approves(entries, `ls${sep}rm -rf /`)).toBe(false);
    expect(approves(entries, `ls${sep}sudo rm -rf /etc${sep}ls`)).toBe(false);
  });

  it('still auto-approves a granted command with only a trailing line break', () => {
    expect(approves([shellGrantEntry('ls')], 'ls\n')).toBe(true);
  });
});

describe('PersistedApprovalGrants', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gsloth-grants-'));
    file = join(dir, 'shell-allowlist.json');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('round-trips a grant through the v2 JSON file', () => {
    const a = new PersistedApprovalGrants(file);
    a.add(grantOf('git checkout main'));

    const onDisk = JSON.parse(readFileSync(file, 'utf8'));
    expect(onDisk).toEqual({
      version: 2,
      grants: [
        {
          entry: { type: 'shell', matcher: 'exact', pattern: 'git checkout main' },
          grantedAt: '2026-08-02T00:00:00.000Z',
          scope: 'always',
        },
      ],
    });

    // A fresh instance loads it, and it grants exactly that command.
    const b = new PersistedApprovalGrants(file);
    expect(approves(b.entries(), 'git checkout main')).toBe(true);
    expect(approves(b.entries(), 'git checkout main --force')).toBe(false);
  });

  it('treats a missing file as empty', () => {
    expect(new PersistedApprovalGrants(join(dir, 'nope.json')).size()).toBe(0);
  });

  it('treats a corrupt file as empty — and a well-formed one is the control', () => {
    const corrupt = join(dir, 'corrupt.json');
    writeFileSync(corrupt, '{ not valid json', 'utf8');
    expect(new PersistedApprovalGrants(corrupt).size()).toBe(0);

    const wellFormed = join(dir, 'ok.json');
    writeFileSync(
      wellFormed,
      JSON.stringify({
        version: 2,
        grants: [grantOf('npm test')],
      }),
      'utf8'
    );
    expect(new PersistedApprovalGrants(wellFormed).size()).toBe(1);
  });

  /**
   * A v2 file whose entries are malformed is a failure mode v1 could not have. Each entry is
   * validated by the config grammar's own schema — one grammar, one validator — so a bad entry is
   * dropped on the way in and can never reach the matcher. The good entries beside it survive:
   * dropping a real grant over a neighbour's typo would cost an approval the human already gave.
   */
  it('drops a malformed entry and keeps its well-formed neighbours', () => {
    writeFileSync(
      file,
      JSON.stringify({
        version: 2,
        grants: [
          { entry: { type: 'shell' }, grantedAt: 'x', scope: 'always' }, // no matcher, no pattern
          { entry: { type: 'shell', matcher: 'exact' }, grantedAt: 'x', scope: 'always' },
          { entry: 'npm test', grantedAt: 'x', scope: 'always' }, // a bare string is not an entry
          { entry: { type: 'shell', matcher: 'exact', pattern: 'npm test', oops: 1 } },
          grantOf('npm test'),
        ],
      }),
      'utf8'
    );
    const store = new PersistedApprovalGrants(file);
    expect(store.size()).toBe(1);
    expect(approves(store.entries(), 'npm test')).toBe(true);
  });

  it('coerces missing grant metadata rather than discarding the grant it describes', () => {
    writeFileSync(
      file,
      JSON.stringify({
        version: 2,
        grants: [{ entry: { type: 'shell', matcher: 'exact', pattern: 'npm test' } }],
      }),
      'utf8'
    );
    const [grant] = new PersistedApprovalGrants(file).list();
    expect(grant.entry).toEqual({ type: 'shell', matcher: 'exact', pattern: 'npm test' });
    expect(grant.scope).toBe('always');
    expect(typeof grant.grantedAt).toBe('string');
  });

  it('survives a write it cannot make, rather than ending the run', () => {
    const unwritable = join(dir, 'no-such-dir', 'grants.json');
    const store = new PersistedApprovalGrants(unwritable);
    expect(() => store.add(grantOf('npm test'))).not.toThrow();
    // The grant is still in force for this session.
    expect(approves(store.entries(), 'npm test')).toBe(true);
  });

  /**
   * §2.4 — **the v1 migration, and the direction it goes.** The shipped v1 file held classified
   * command PREFIXES, so a stored `npm test` also auto-approved `npm test --watch`. Each becomes an
   * `exact` entry for the same string. That narrows the file on purpose: a v1 prefix was broader
   * than what the human was actually shown when they answered the prompt, so narrowing it costs at
   * worst a re-prompt and never an execution.
   */
  describe('the v1 → v2 migration', () => {
    const writeV1 = (prefixes: string[]) =>
      writeFileSync(file, JSON.stringify({ version: 1, prefixes }), 'utf8');

    it('NARROWS: a v1 `npm test` prefix no longer approves `npm test --watch`', () => {
      writeV1(['npm test']);
      const store = new PersistedApprovalGrants(file);
      // The behaviour, not the shape: the whole point of the migration.
      expect(approves(store.entries(), 'npm test --watch')).toBe(false);
      // Control — it still approves the command it was granted for, so this is a narrowing and not
      // a silent drop of the user's saved approvals.
      expect(approves(store.entries(), 'npm test')).toBe(true);
    });

    it('keeps every prefix, as an exact entry, with grant metadata', () => {
      writeV1(['npm test', 'git status', 'ls']);
      const store = new PersistedApprovalGrants(file);
      expect(store.entries()).toEqual([
        { type: 'shell', matcher: 'exact', pattern: 'npm test' },
        { type: 'shell', matcher: 'exact', pattern: 'git status' },
        { type: 'shell', matcher: 'exact', pattern: 'ls' },
      ]);
      for (const grant of store.list()) {
        expect(grant.scope).toBe('always');
        expect(Date.parse(grant.grantedAt)).not.toBeNaN();
      }
    });

    it('reports the change ONCE, naming the file — not once per entry', () => {
      writeV1(['npm test', 'git status', 'ls']);
      const onNotice = vi.fn();
      new PersistedApprovalGrants(file, { onNotice });

      expect(onNotice).toHaveBeenCalledTimes(1);
      const message = onNotice.mock.calls[0][0].message as string;
      expect(message).toContain(file);
      // It says what changed about the meaning of their saved approvals, not merely that something
      // was upgraded.
      expect(message).toContain('PREFIX');
    });

    it('control — a store already at v2 migrates nothing and says nothing', () => {
      writeFileSync(file, JSON.stringify({ version: 2, grants: [grantOf('npm test')] }), 'utf8');
      const onNotice = vi.fn();
      const store = new PersistedApprovalGrants(file, { onNotice });
      expect(onNotice).not.toHaveBeenCalled();
      expect(store.size()).toBe(1);
    });

    it('rewrites the file, so the notice is a one-time event and not a per-session one', () => {
      writeV1(['npm test']);
      const first = vi.fn();
      new PersistedApprovalGrants(file, { onNotice: first });
      expect(first).toHaveBeenCalledTimes(1);
      expect(JSON.parse(readFileSync(file, 'utf8')).version).toBe(2);

      const second = vi.fn();
      const reopened = new PersistedApprovalGrants(file, { onNotice: second });
      expect(second).not.toHaveBeenCalled();
      expect(approves(reopened.entries(), 'npm test')).toBe(true);
    });

    it('says nothing about an empty v1 file, having changed nothing the user can notice', () => {
      writeV1([]);
      const onNotice = vi.fn();
      expect(new PersistedApprovalGrants(file, { onNotice }).size()).toBe(0);
      expect(onNotice).not.toHaveBeenCalled();
    });

    it('ignores non-string and blank prefixes rather than granting something meaningless', () => {
      writeFileSync(
        file,
        JSON.stringify({ version: 1, prefixes: ['npm test', '', '   ', 42, null] }),
        'utf8'
      );
      const store = new PersistedApprovalGrants(file);
      expect(store.entries()).toEqual([{ type: 'shell', matcher: 'exact', pattern: 'npm test' }]);
    });
  });
});
