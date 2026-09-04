import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import {
  decodeConversationGrants,
  encodeConversationGrants,
  loadConversationGrantsSafe,
  saveConversationGrantsSafe,
} from '#src/core/approvals/conversationGrants.js';
import { openConversationSafe } from '#src/history/recordSession.js';
import type { ApprovalGrant } from '#src/core/approvals/grants.js';
import { resolveApprovalRules } from '#src/core/approvals/matcher.js';

/**
 * GS2-20 — the document that carries a conversation's grants across a restart.
 *
 * The codec is asserted through the MATCHER where a grant is involved, because "the entry came back
 * looking right" is not the property: "the entry that came back still approves the command it was
 * made for" is. A codec that mangled a pattern in a way the shape check could not see would pass an
 * equality on the object and fail the gate.
 */
const shellGrant = (pattern: string, scope: 'session' | 'always' = 'session'): ApprovalGrant => ({
  entry: { type: 'shell', matcher: 'exact', pattern },
  grantedAt: '2026-09-03T10:00:00.000Z',
  scope,
});

const approves = (grants: readonly ApprovalGrant[], command: string): boolean =>
  resolveApprovalRules(
    { kind: 'shell', command },
    { allow: grants.map((g) => g.entry), deny: [], escalate: [] }
  )?.action === 'allow';

describe('approvals/conversationGrants — the codec', () => {
  it('round-trips allow and deny grants, and the entries still match what they were made for', () => {
    const json = encodeConversationGrants({
      allow: [shellGrant('ls -la')],
      deny: [shellGrant('rm -rf build')],
    });
    expect(json).toBeTypeOf('string');
    const back = decodeConversationGrants(json);
    expect(approves(back.allow, 'ls -la')).toBe(true);
    expect(approves(back.allow, 'ls')).toBe(false);
    expect(back.deny.map((g) => g.entry)).toEqual([
      { type: 'shell', matcher: 'exact', pattern: 'rm -rf build' },
    ]);
    // Display metadata survives too — `/approvals` shows when a grant was made.
    expect(back.allow[0].grantedAt).toBe('2026-09-03T10:00:00.000Z');
  });

  it('encodes nothing as null, so a conversation that granted nothing keeps a NULL column', () => {
    expect(encodeConversationGrants({ allow: [], deny: [] })).toBeNull();
    expect(decodeConversationGrants(null)).toEqual({ allow: [], deny: [] });
  });

  it('reads anything unreadable as NO grants — never as a grant the person did not make', () => {
    expect(decodeConversationGrants('not json{')).toEqual({ allow: [], deny: [] });
    expect(decodeConversationGrants('[]')).toEqual({ allow: [], deny: [] });
    expect(decodeConversationGrants('"a string"')).toEqual({ allow: [], deny: [] });
    // A later version is not guessed at.
    expect(decodeConversationGrants('{"version":2,"allow":[{"entry":{}}],"deny":[]}')).toEqual({
      allow: [],
      deny: [],
    });
    // A version-1 document whose lists are not lists.
    expect(decodeConversationGrants('{"version":1,"allow":{},"deny":"x"}')).toEqual({
      allow: [],
      deny: [],
    });
  });

  it('skips a malformed entry on its own and keeps the ones beside it', () => {
    const json = JSON.stringify({
      version: 1,
      allow: [
        { entry: { type: 'shell', matcher: 'exact', pattern: 'ls -la' }, scope: 'session' },
        { entry: { type: 'nonsense' }, scope: 'session' },
        'not an object',
      ],
      deny: [],
    });
    const back = decodeConversationGrants(json);
    expect(back.allow).toHaveLength(1);
    expect(approves(back.allow, 'ls -la')).toBe(true);
  });

  it('forces every restored scope to `session` — this document never speaks for the project store', () => {
    const json = encodeConversationGrants({ allow: [shellGrant('ls -la', 'always')], deny: [] });
    expect(decodeConversationGrants(json).allow[0].scope).toBe('session');
    // And a document that was hand-edited to claim `always` is read the same way.
    const claimed = JSON.stringify({
      version: 1,
      allow: [{ entry: { type: 'shell', matcher: 'exact', pattern: 'ls' }, scope: 'always' }],
      deny: [],
    });
    expect(decodeConversationGrants(claimed).allow[0].scope).toBe('session');
  });
});

describe('approvals/conversationGrants — against the store', () => {
  let dir: string;
  let dbPath: string;
  beforeEach(() => {
    dir = mkdtempSync(resolve(tmpdir(), 'gsloth-conv-grants-'));
    dbPath = resolve(dir, 'history.db');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('saves against one conversation and loads it back for that one only', () => {
    const config = { history: { dbPath } };
    const a = openConversationSafe(config, { command: 'code', threadId: 'ta' })!;
    const b = openConversationSafe(config, { command: 'code', threadId: 'tb' })!;

    saveConversationGrantsSafe(config, a, { allow: [shellGrant('ls -la')], deny: [] });

    expect(approves(loadConversationGrantsSafe(config, a).allow, 'ls -la')).toBe(true);
    expect(loadConversationGrantsSafe(config, b)).toEqual({ allow: [], deny: [] });
    // A later save REPLACES: what the conversation has now, not an accumulation.
    saveConversationGrantsSafe(config, a, { allow: [], deny: [shellGrant('rm -rf build')] });
    const after = loadConversationGrantsSafe(config, a);
    expect(after.allow).toEqual([]);
    expect(after.deny).toHaveLength(1);
    // And clearing them clears the row.
    saveConversationGrantsSafe(config, a, { allow: [], deny: [] });
    expect(loadConversationGrantsSafe(config, a)).toEqual({ allow: [], deny: [] });
  });

  it('is a no-op with no conversation to write against, and creates no store', () => {
    const config = { history: { dbPath } };
    expect(() =>
      saveConversationGrantsSafe(config, undefined, { allow: [shellGrant('ls')], deny: [] })
    ).not.toThrow();
    expect(existsSync(dbPath)).toBe(false);
    expect(loadConversationGrantsSafe(config, 1)).toEqual({ allow: [], deny: [] });
    expect(existsSync(dbPath)).toBe(false);
  });

  it('writes nothing and restores nothing when history.enabled is false — one switch', () => {
    const on = { history: { dbPath } };
    const off = { history: { enabled: false, dbPath } };
    const id = openConversationSafe(on, { command: 'code', threadId: 't' })!;
    saveConversationGrantsSafe(off, id, { allow: [shellGrant('ls -la')], deny: [] });
    expect(loadConversationGrantsSafe(on, id)).toEqual({ allow: [], deny: [] });
    saveConversationGrantsSafe(on, id, { allow: [shellGrant('ls -la')], deny: [] });
    expect(loadConversationGrantsSafe(off, id)).toEqual({ allow: [], deny: [] });
    // The control: the row does hold them when the switch is on.
    expect(loadConversationGrantsSafe(on, id).allow).toHaveLength(1);
  });
});
