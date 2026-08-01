import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  annotationWeakenings,
  ApprovalGrantStore,
  describeWeakenedGrant,
  PersistedApprovalGrants,
  shellGrantEntry,
  toolGrantEntry,
  trustWithdrawalWeakens,
  type ApprovalGrant,
} from '#src/core/approvals/grants.js';
import {
  type ApprovalSubject,
  type EffectiveToolAnnotations,
  MCP_FAIL_CLOSED_ANNOTATIONS,
  type McpToolApprovalSubject,
  resolveApprovalRules,
  type ToolApprovalSubject,
} from '#src/core/approvals/matcher.js';
import { UNRESOLVED_MCP_SERVER } from '#src/core/approvals/mcpSubjects.js';
import { approvalEntrySchema } from '#src/config/schema.js';
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

/** Does this set of entries, as an allow list, approve this tool call? */
const approvesSubject = (entries: readonly ApprovalEntry[], subject: ApprovalSubject): boolean =>
  resolveApprovalRules(subject, { allow: entries, deny: [], escalate: [] })?.action === 'allow';

const toolSubject = (name: string, host?: string): ToolApprovalSubject => ({
  kind: 'tool',
  name,
  ...(host !== undefined ? { host } : {}),
});

const mcpSubject = (server: string, name: string, host?: string): McpToolApprovalSubject => ({
  kind: 'mcpTool',
  server,
  name,
  ...(host !== undefined ? { host } : {}),
});

/**
 * EXT-70 §4.7.4/§6 — what the escalation menu writes for a TOOL call: identity, and the host where
 * the call carries one. Everything here that asks "does this grant cover that call" asks it through
 * `resolveApprovalRules`, for the same reason the shell block above does.
 */
describe('toolGrantEntry — what the menu writes for a tool call (§4.7.4, §6)', () => {
  it('writes the tool identity, never the arguments', () => {
    expect(toolGrantEntry(toolSubject('gth_web_fetch'))).toEqual({
      type: 'tool',
      matcher: 'exact',
      pattern: 'gth_web_fetch',
    });
    expect(toolGrantEntry(mcpSubject('jira', 'create_issue'))).toEqual({
      type: 'mcpTool',
      server: 'jira',
      matcher: 'exact',
      pattern: 'create_issue',
    });
  });

  it('records the host where the call carries one', () => {
    expect(toolGrantEntry(mcpSubject('fetcher', 'fetch_url', 'docs.internal.example'))).toEqual({
      type: 'mcpTool',
      server: 'fetcher',
      matcher: 'exact',
      pattern: 'fetch_url',
      host: 'docs.internal.example',
    });
  });

  /**
   * The entry is written in the ONE grammar, so it survives the round trip through the file that
   * `readGrant` validates it with. An entry that did not would be written, silently dropped on the
   * next read, and the human would have been told their approval was remembered when it was not.
   */
  it('writes an entry the config grammar itself accepts', () => {
    for (const subject of [
      toolSubject('gth_web_fetch'),
      toolSubject('gth_web_fetch', 'docs.internal.example'),
      mcpSubject('jira', 'create_issue'),
      mcpSubject('fetcher', 'fetch_url', 'docs.internal.example'),
    ]) {
      expect(approvalEntrySchema.safeParse(toolGrantEntry(subject)).success).toBe(true);
    }
  });

  /**
   * §4.7.5 — a server's identity is the user's own config key, which the unresolved sentinel is
   * deliberately not: `server` is `z.string().min(1)`, so such an entry could be written and never
   * read back. A call nobody can attribute is not one anything can remember.
   */
  it('offers NO entry for a call whose server could not be resolved', () => {
    expect(toolGrantEntry(mcpSubject(UNRESOLVED_MCP_SERVER, 'mcp__ghost__delete'))).toBeNull();
    // CONTROL: the same tool under a server that DID resolve gets one.
    expect(toolGrantEntry(mcpSubject('ghost', 'delete'))).not.toBeNull();
  });

  /**
   * §4.7.5 — the whole point of recording the server key. A grant for one server's `delete_issue`
   * cannot be claimed by another server exposing the same tool name.
   */
  it('a grant for one server never matches another server’s same-named tool', () => {
    const entries = [toolGrantEntry(mcpSubject('jira', 'delete_issue'))!];
    expect(approvesSubject(entries, mcpSubject('gitlab', 'delete_issue'))).toBe(false);
    // CONTROL — otherwise this passes on a matcher that matches nothing at all.
    expect(approvesSubject(entries, mcpSubject('jira', 'delete_issue'))).toBe(true);
  });

  /** §4.7.1 — and it cannot be claimed by one of OUR OWN tools of the same name either. */
  it('a grant for a server’s tool never matches a built-in of that name', () => {
    const entries = [toolGrantEntry(mcpSubject('jira', 'search'))!];
    expect(approvesSubject(entries, toolSubject('search'))).toBe(false);
    expect(approvesSubject(entries, mcpSubject('jira', 'search'))).toBe(true);
  });

  /**
   * §4.7.4's bound, both halves. Without the second the first passes on a grant that matches
   * nothing; without the first it passes on a grant that ignores the host entirely.
   */
  it('a tool+host grant approves the SAME host and not a different one', () => {
    const entries = [toolGrantEntry(toolSubject('gth_web_fetch', 'docs.internal.example'))!];
    expect(approvesSubject(entries, toolSubject('gth_web_fetch', 'docs.internal.example'))).toBe(
      true
    );
    expect(approvesSubject(entries, toolSubject('gth_web_fetch', 'evil.example'))).toBe(false);
    // …and a call carrying no host at all does not slip past the bound either.
    expect(approvesSubject(entries, toolSubject('gth_web_fetch'))).toBe(false);
  });
});

/**
 * EXT-70 §4.7.4 — the three moves that weaken an effective annotation set, and nothing else.
 */
describe('annotationWeakenings — what invalidates a grant (§4.7.4)', () => {
  /**
   * Each move gets its own case, and each asserts it moved ALONE. One representative case would
   * pass on a checker that implements one field and misses two; a case that reported two hints
   * would pass on a checker that reports every hint it looked at.
   *
   * The `destructiveHint` row needs `readOnlyHint: false` on BOTH sides on purpose: effective
   * `readOnlyHint: true` derives `destructiveHint: false` (§4.7.1), so a snapshot spelled the
   * obvious way would move two hints at once and prove nothing about `destructiveHint`.
   */
  const readOnly = (readOnlyHint: boolean): EffectiveToolAnnotations => ({
    readOnlyHint,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  });
  const openWorld = (openWorldHint: boolean): EffectiveToolAnnotations => ({
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint,
  });
  const destructive = (destructiveHint: boolean): EffectiveToolAnnotations => ({
    readOnlyHint: false,
    destructiveHint,
    idempotentHint: true,
    openWorldHint: false,
  });

  it.each([
    ['readOnlyHint true → false', readOnly(true), readOnly(false), 'readOnlyHint'],
    ['openWorldHint false → true', openWorld(false), openWorld(true), 'openWorldHint'],
    ['destructiveHint false → true', destructive(false), destructive(true), 'destructiveHint'],
  ])('%s weakens, and names exactly that hint', (_label, snapshot, current, hint) => {
    expect(annotationWeakenings(snapshot, current)).toEqual([hint]);
  });

  it.each([
    ['readOnlyHint false → true', readOnly(false), readOnly(true)],
    ['openWorldHint true → false', openWorld(true), openWorld(false)],
    ['destructiveHint true → false', destructive(true), destructive(false)],
  ])('the mirror image (%s) strengthens and does NOT invalidate', (_label, snapshot, current) => {
    expect(annotationWeakenings(snapshot, current)).toEqual([]);
    // CONTROL: the very same pair the other way round DOES.
    expect(annotationWeakenings(current, snapshot).length).toBe(1);
  });

  it('an unchanged set weakens nothing', () => {
    expect(annotationWeakenings(readOnly(true), readOnly(true))).toEqual([]);
    expect(
      annotationWeakenings(MCP_FAIL_CLOSED_ANNOTATIONS, { ...MCP_FAIL_CLOSED_ANNOTATIONS })
    ).toEqual([]);
  });

  /**
   * §4.7.2 — `idempotentHint` has no built-in consumer, and it is not one of the three moves. The
   * CONTROL is in the same test: a hint that IS one of them, moved in the same call, does register.
   */
  it('idempotentHint moving either way invalidates nothing — CONTROL: openWorldHint does', () => {
    const before: EffectiveToolAnnotations = { ...openWorld(false), idempotentHint: true };
    expect(annotationWeakenings(before, { ...before, idempotentHint: false })).toEqual([]);
    expect(annotationWeakenings({ ...before, idempotentHint: false }, before)).toEqual([]);
    expect(annotationWeakenings(before, { ...before, openWorldHint: true })).toEqual([
      'openWorldHint',
    ]);
  });

  it('reports every hint that moved when several do', () => {
    const before: EffectiveToolAnnotations = {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    };
    const after: EffectiveToolAnnotations = {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    };
    expect(annotationWeakenings(before, after).sort()).toEqual(
      ['destructiveHint', 'openWorldHint', 'readOnlyHint'].sort()
    );
  });

  /**
   * §4.7.4 — the notice names the tool, the server and **the hint that moved**.
   *
   * The absence half is what makes the presence half mean anything. A notice built from the four
   * hints rather than from the `weakened` list satisfies every `toContain` below and reads
   * *"openWorldHint changed from false to false"* — the gate telling the human about a change that
   * did not happen, which is worse than saying nothing. `annotationWeakenings` is what decides which
   * hints those are, and it is proven exactly-that-hint above; this is what stops the notice
   * quietly not inheriting it.
   */
  it('the notice names the tool, the server and the hint that MOVED — and no other', () => {
    const message = describeWeakenedGrant(
      toolGrantEntry(mcpSubject('jira', 'search'))!,
      ['readOnlyHint'],
      readOnly(true),
      readOnly(false)
    );
    expect(message).toContain('search');
    expect(message).toContain('jira');
    expect(message).toContain('readOnlyHint');
    expect(message).toContain('true');
    expect(message).toContain('false');
    // The three that stayed exactly where they were, in both snapshots.
    expect(message).not.toContain('openWorldHint');
    expect(message).not.toContain('destructiveHint');
    expect(message).not.toContain('idempotentHint');
  });

  /**
   * It describes the GRANT, not the call, so the two notices one call can produce — a host-bound
   * grant and a tool-only one — are told apart. Identical notices would read as the gate repeating
   * itself.
   */
  it('the notice names the host bound where the withdrawn grant had one', () => {
    const bound = describeWeakenedGrant(
      toolGrantEntry(toolSubject('gth_web_fetch', 'docs.internal.example'))!,
      ['openWorldHint'],
      openWorld(false),
      openWorld(true)
    );
    const unbound = describeWeakenedGrant(
      toolGrantEntry(toolSubject('gth_web_fetch'))!,
      ['openWorldHint'],
      openWorld(false),
      openWorld(true)
    );
    expect(bound).toContain('docs.internal.example');
    expect(unbound).not.toContain('docs.internal.example');
    expect(bound).not.toBe(unbound);
  });
});

/**
 * EXT-70 §4.7.1/§4.7.4 — **which hints, when trust in them is WITHDRAWN, can invalidate a grant.**
 *
 * This is what lets the surface where a user withdraws trust say so there, instead of letting them
 * meet the withdrawal notice three turns later. It is also the one place this node's own brief was
 * wrong, so it is asserted against the moves rather than against the prose: `destructiveHint`'s
 * fail-closed default is `true`, and `destructiveHint` false→true IS a weakening move, so ceasing
 * to believe a server's `destructiveHint: false` makes its tools destructive again.
 */
describe('trustWithdrawalWeakens — withdrawing trust is a weakening, for three hints of four', () => {
  it.each([['readOnlyHint'], ['openWorldHint'], ['destructiveHint']] as const)(
    'withdrawing %s can weaken, so it can invalidate a grant',
    (hint) => {
      expect(trustWithdrawalWeakens(hint)).toBe(true);
    }
  );

  /**
   * The only negative, and its control is the `it.each` above: `idempotentHint` appears in no
   * weakening move at any declared value, so withdrawing it invalidates nothing. Asserting only
   * this would pass on a function that returned `false` for everything.
   */
  it('withdrawing idempotentHint can NOT weaken — it names no move', () => {
    expect(trustWithdrawalWeakens('idempotentHint')).toBe(false);
  });

  /**
   * The end-to-end evidence for the `destructiveHint` row, built the way the derivation actually
   * builds an effective set rather than by restating the table. `readOnlyHint` is false on BOTH
   * sides deliberately: an effective `readOnlyHint: true` derives `destructiveHint: false` (§4.7.1),
   * so the obvious spelling would move two hints and prove nothing about `destructiveHint` alone.
   */
  it('a believed destructiveHint:false really does weaken when it stops being believed', () => {
    const believed: EffectiveToolAnnotations = {
      ...MCP_FAIL_CLOSED_ANNOTATIONS,
      destructiveHint: false,
    };
    expect(annotationWeakenings(believed, { ...MCP_FAIL_CLOSED_ANNOTATIONS })).toEqual([
      'destructiveHint',
    ]);
  });

  /**
   * The mirror: GRANTING trust can never weaken, because every weakening move ENDS at the
   * fail-closed default and believing a hint only ever moves away from it. Stated as its own
   * assertion because it is what makes the withdrawal warning specific to withdrawal — a notice
   * shown on both would be noise, and one shown on neither would be the surprise §4.7.4 creates.
   */
  it.each([['readOnlyHint'], ['openWorldHint'], ['destructiveHint'], ['idempotentHint']] as const)(
    'believing %s moves AWAY from the fail-closed default, so it never weakens',
    (hint) => {
      const believed: EffectiveToolAnnotations = {
        ...MCP_FAIL_CLOSED_ANNOTATIONS,
        [hint]: !MCP_FAIL_CLOSED_ANNOTATIONS[hint],
      };
      expect(annotationWeakenings({ ...MCP_FAIL_CLOSED_ANNOTATIONS }, believed)).toEqual([]);
    }
  );
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

  it('finds and removes a grant by entry identity', () => {
    const store = new ApprovalGrantStore();
    const entry = toolGrantEntry(mcpSubject('jira', 'create_issue'))!;
    expect(store.find(entry)).toBeUndefined();
    expect(store.remove(entry)).toBe(false);

    store.add({ entry, grantedAt: '2026-08-02T00:00:00.000Z', scope: 'always' });
    expect(store.find(entry)?.entry).toEqual(entry);
    expect(store.remove(entry)).toBe(true);
    expect(store.size()).toBe(0);
    // …and only that one: a neighbour with a different identity is untouched.
    const other = toolGrantEntry(mcpSubject('jira', 'search'))!;
    store.add({ entry, grantedAt: '2026-08-02T00:00:00.000Z', scope: 'always' });
    store.add({ entry: other, grantedAt: '2026-08-02T00:00:00.000Z', scope: 'always' });
    store.remove(entry);
    expect(store.entries()).toEqual([other]);
  });

  /**
   * §4.7.4 — **removal, not a skip.** The store de-duplicates by entry identity, so a grant that was
   * ignored rather than removed would silently swallow the human's re-approval of the same tool:
   * `add` would return false and the stale snapshot would go on invalidating it forever.
   */
  it('a removed grant can be re-granted, with a NEW snapshot', () => {
    const store = new ApprovalGrantStore();
    const entry = toolGrantEntry(mcpSubject('jira', 'search'))!;
    const before: EffectiveToolAnnotations = {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    };
    store.add({ entry, grantedAt: 'a', scope: 'always', annotations: before });
    // The control for the whole test: without removing first, the re-grant is a silent no-op.
    expect(
      store.add({
        entry,
        grantedAt: 'b',
        scope: 'always',
        annotations: { ...before, readOnlyHint: false },
      })
    ).toBe(false);

    store.remove(entry);
    expect(
      store.add({
        entry,
        grantedAt: 'b',
        scope: 'always',
        annotations: { ...before, readOnlyHint: false },
      })
    ).toBe(true);
    expect(store.find(entry)?.annotations?.readOnlyHint).toBe(false);
  });

  /**
   * §4.7.4 — **the snapshot is a PRIVATE COPY.** An effective set is something a source hands out
   * and a caller may hold, and the shared fail-closed constant is what an unconfigured source
   * resolves to, so a store that kept the caller's object would let one grant's record be rewritten
   * from outside it — or, worse, rewrite the constant for every other reader.
   */
  it('holds a private copy of the snapshot: mutating it moves nothing else', () => {
    const store = new ApprovalGrantStore();
    const source: EffectiveToolAnnotations = { ...MCP_FAIL_CLOSED_ANNOTATIONS };
    const first = toolGrantEntry(mcpSubject('jira', 'search'))!;
    const second = toolGrantEntry(mcpSubject('jira', 'create_issue'))!;
    store.add({ entry: first, grantedAt: 'a', scope: 'always', annotations: source });
    store.add({ entry: second, grantedAt: 'a', scope: 'always', annotations: source });

    const held = store.find(first)!.annotations!;
    expect(held).toEqual(MCP_FAIL_CLOSED_ANNOTATIONS);
    held.readOnlyHint = true;
    held.openWorldHint = false;

    // The object the caller passed in is untouched…
    expect(source).toEqual(MCP_FAIL_CLOSED_ANNOTATIONS);
    // …the shared constant is untouched (it would be the same object on a regressed source)…
    expect(MCP_FAIL_CLOSED_ANNOTATIONS.readOnlyHint).toBe(false);
    expect(MCP_FAIL_CLOSED_ANNOTATIONS.openWorldHint).toBe(true);
    // …and the second grant, built from the very same source object, is untouched.
    expect(store.find(second)!.annotations).toEqual(MCP_FAIL_CLOSED_ANNOTATIONS);
    // CONTROL: the mutation really did land somewhere, so this is isolation and not a no-op.
    expect(store.find(first)!.annotations!.readOnlyHint).toBe(true);
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

  /**
   * §4.7.4 — the snapshot round-trips through the file, because invalidation compares against it
   * across sessions: a snapshot that did not survive the write would make every reopened grant
   * un-invalidatable.
   */
  it('round-trips a tool grant’s annotation snapshot through the file', () => {
    const entry = toolGrantEntry(mcpSubject('fetcher', 'fetch_url', 'docs.internal.example'))!;
    const annotations: EffectiveToolAnnotations = {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    };
    const a = new PersistedApprovalGrants(file);
    a.add({ entry, grantedAt: '2026-08-02T00:00:00.000Z', scope: 'always', annotations });

    expect(JSON.parse(readFileSync(file, 'utf8')).grants[0].annotations).toEqual(annotations);
    expect(new PersistedApprovalGrants(file).find(entry)?.annotations).toEqual(annotations);
  });

  /**
   * A removal must reach the FILE. Held only in memory it would be undone by the next session
   * reloading the same stale snapshot, so §4.7.4's invalidation would fire once per session forever
   * instead of once.
   */
  it('removing a grant rewrites the file, so it stays removed', () => {
    const entry = toolGrantEntry(mcpSubject('jira', 'search'))!;
    const store = new PersistedApprovalGrants(file);
    store.add({ entry, grantedAt: '2026-08-02T00:00:00.000Z', scope: 'always' });
    // CONTROL: it really was persisted before the removal.
    expect(new PersistedApprovalGrants(file).size()).toBe(1);

    expect(store.remove(entry)).toBe(true);
    expect(new PersistedApprovalGrants(file).size()).toBe(0);
  });

  /**
   * §4.7.4 — **a malformed snapshot drops the whole grant**, unlike the other metadata, and the
   * difference is that this field DECIDES. A coerced snapshot (a string `"true"` read as truthy)
   * would feed a wrong comparison into invalidation and could conclude that a weakened tool had not
   * weakened; dropping the grant costs only a re-prompt.
   */
  it.each([
    [
      'a non-boolean hint value',
      { readOnlyHint: 'true', destructiveHint: false, idempotentHint: true, openWorldHint: false },
    ],
    ['a missing hint', { readOnlyHint: true, destructiveHint: false, idempotentHint: true }],
    ['not an object at all', 'readOnly'],
    ['an array', [true, false, true, false]],
  ])('drops a grant whose snapshot is %s', (_label, annotations) => {
    const entry = toolGrantEntry(mcpSubject('jira', 'search'))!;
    writeFileSync(
      file,
      JSON.stringify({
        version: 2,
        grants: [{ entry, grantedAt: 'x', scope: 'always', annotations }],
      }),
      'utf8'
    );
    expect(new PersistedApprovalGrants(file).size()).toBe(0);
  });

  it('CONTROL: the same grant with a well-formed snapshot survives', () => {
    const entry = toolGrantEntry(mcpSubject('jira', 'search'))!;
    writeFileSync(
      file,
      JSON.stringify({
        version: 2,
        grants: [
          {
            entry,
            grantedAt: 'x',
            scope: 'always',
            annotations: {
              readOnlyHint: true,
              destructiveHint: false,
              idempotentHint: true,
              openWorldHint: false,
            },
          },
        ],
      }),
      'utf8'
    );
    expect(new PersistedApprovalGrants(file).size()).toBe(1);
  });

  /**
   * Forward compatibility with a v2 file written before the snapshot existed: no `annotations` is
   * not a malformed one. Such a grant simply has nothing to compare against, so it stands — the
   * safe direction, since the alternative would silently drop approvals the human already gave.
   */
  it('keeps a tool grant that has no snapshot at all', () => {
    const entry = toolGrantEntry(mcpSubject('jira', 'search'))!;
    writeFileSync(
      file,
      JSON.stringify({ version: 2, grants: [{ entry, grantedAt: 'x', scope: 'always' }] }),
      'utf8'
    );
    const store = new PersistedApprovalGrants(file);
    expect(store.size()).toBe(1);
    expect(store.find(entry)?.annotations).toBeUndefined();
    expect(approvesSubject(store.entries(), mcpSubject('jira', 'search'))).toBe(true);
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
