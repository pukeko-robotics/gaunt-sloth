/**
 * [[EXT-80]] acceptance — **which tools the two deterministic rungs actually gate.**
 *
 * `read-only` and `write` publish a promise: everything beyond reading (respectively, beyond
 * reading and writing files in the working folder) comes to the user for approval. That promise is
 * kept by {@link resolveGatedToolNames}, which both backends and `GthAgentRunner` build their gated
 * set from.
 *
 * Two properties are asserted, and they are different questions:
 *
 * 1. **Membership**, against LITERAL expected name lists per rung. Deriving the expectation from
 *    the same predicate the implementation uses would assert nothing, so the lists below are
 *    written out by hand: change {@link BUILT_IN_TOOL_ACCESS} or the rung rule and these go red.
 * 2. **Agreement** with {@link isGrantedAtRung}, so the set the gate wires and the grant the tool
 *    descriptions and the rater's summary report cannot drift apart.
 *
 * The fixture is one representative bound toolset covering every class that behaves differently:
 * both read-name families (gsloth's and deepagents'), all six write built-ins, the two shells, MCP
 * with and without `readOnlyHint`, a custom tool, and the internal bookkeeping tools.
 */
import { describe, expect, it } from 'vitest';
import {
  APPROVAL_RUNGS,
  BUILT_IN_TOOL_ACCESS,
  describeGrantedBuiltInTools,
  isAccessClassGrantedAtRung,
  isDeterministicRung,
  isGrantedAtRung,
  isToolGatedAtRung,
  resolveGatedToolNames,
  resolveInterruptToolNames,
  SHELL_TOOL_NAME,
  type ApprovalRung,
} from '#src/config.js';

/** gsloth's `GthFileSystemToolkit` read tools, plus deepagents' differently-named ones. */
const READ_BUILT_INS = [
  'read_file',
  'read_multiple_files',
  'gth_read_binary',
  'list_directory',
  'list_directory_with_sizes',
  'directory_tree',
  'search_files',
  'get_file_info',
  'list_allowed_directories',
  'ls',
  'glob',
  'grep',
  'gth_grep',
] as const;

/**
 * All SIX write built-ins. `move_file` is the trap: the node prose names five, and a hand-written
 * gated list is how it goes missing.
 */
const WRITE_BUILT_INS = [
  'write_file',
  'edit_file',
  'create_directory',
  'move_file',
  'delete_file',
  'delete_directory',
] as const;

/**
 * Tools with NO access class. Every one of them must escalate at both deterministic rungs — this is
 * the literal reading of "everything else escalates", including the internal bookkeeping tools that
 * look harmless and deepagents' `execute`, which is a shell wearing a filesystem-sounding name.
 */
const UNCLASSED = [
  SHELL_TOOL_NAME,
  'execute',
  'mcp__docs__search', // declares readOnlyHint: true — earns nothing at these two rungs
  'mcp__jira__create_issue',
  'my_custom_tool',
  'gth_checklist',
  'gth_status_update',
  'gth_web_fetch',
  'show_a2ui_surface',
  'run_tests',
] as const;

/** The representative bound toolset, in a deliberately interleaved order. */
const BOUND = [
  'read_file',
  'write_file',
  SHELL_TOOL_NAME,
  'mcp__docs__search',
  'ls',
  'edit_file',
  'my_custom_tool',
  'glob',
  'create_directory',
  'mcp__jira__create_issue',
  'grep',
  'move_file',
  'gth_checklist',
  'delete_file',
  'execute',
  'gth_grep',
  'delete_directory',
  'gth_web_fetch',
  'gth_status_update',
  'show_a2ui_surface',
  'run_tests',
  'read_multiple_files',
  'gth_read_binary',
  'list_directory',
  'list_directory_with_sizes',
  'directory_tree',
  'search_files',
  'get_file_info',
  'list_allowed_directories',
] as const;

const gatedAt = (rung: ApprovalRung, gateShell = true): readonly string[] =>
  resolveGatedToolNames({ rung, gateShell, boundToolNames: BOUND });

describe('EXT-80 — the access-class predicate', () => {
  it('grants every read built-in at every rung', () => {
    for (const rung of APPROVAL_RUNGS) {
      for (const name of READ_BUILT_INS) {
        expect(isAccessClassGrantedAtRung(name, rung)).toBe(true);
      }
    }
  });

  it('grants the write built-ins everywhere except read-only', () => {
    for (const name of WRITE_BUILT_INS) {
      expect(isAccessClassGrantedAtRung(name, 'read-only')).toBe(false);
      expect(isAccessClassGrantedAtRung(name, 'write')).toBe(true);
      expect(isAccessClassGrantedAtRung(name, 'auto-safe')).toBe(true);
      expect(isAccessClassGrantedAtRung(name, 'full-auto')).toBe(true);
    }
  });

  it('grants a tool with no access class at NO rung', () => {
    // Including `bypass`: that rung grants everything for an unrelated reason (the gate is off),
    // which is `isGrantedAtRung`'s business, not this predicate's.
    for (const rung of APPROVAL_RUNGS) {
      for (const name of UNCLASSED) {
        expect(isAccessClassGrantedAtRung(name, rung)).toBe(false);
      }
    }
  });

  it('classifies exactly six built-ins as write, move_file among them', () => {
    const writes = Object.keys(BUILT_IN_TOOL_ACCESS).filter(
      (name) => BUILT_IN_TOOL_ACCESS[name] === 'write'
    );
    expect(writes.sort()).toEqual([...WRITE_BUILT_INS].sort());
  });

  it('separates the deterministic rungs from the rest', () => {
    expect(APPROVAL_RUNGS.filter((rung) => isDeterministicRung(rung))).toEqual([
      'read-only',
      'write',
    ]);
  });
});

describe('EXT-80 — resolveGatedToolNames membership', () => {
  it('gates everything but the read built-ins at read-only', () => {
    expect([...gatedAt('read-only')].sort()).toEqual(
      [...WRITE_BUILT_INS, ...UNCLASSED].sort() as string[]
    );
  });

  it('gates everything but the read AND write built-ins at write', () => {
    expect([...gatedAt('write')].sort()).toEqual([...UNCLASSED].sort() as string[]);
  });

  it.each(['auto-safe', 'full-auto', 'bypass'] as const)(
    'gates the shell and nothing else at %s',
    (rung) => {
      expect(gatedAt(rung)).toEqual([SHELL_TOOL_NAME]);
    }
  );

  it.each(['auto-safe', 'full-auto', 'bypass'] as const)(
    'gates nothing at all at %s when the shell tool is disabled',
    (rung) => {
      expect(gatedAt(rung, false)).toEqual([]);
    }
  );

  it('still gates the non-granted tools at a deterministic rung when the shell gate is off', () => {
    // A `chat` session wires no shell gate but may hold MCP and custom tools, and `read-only`
    // promises those come to the user. Keying the gate off `gateShell` would break that promise.
    // The shell tool being disabled means it is not bound either, so it is absent from both sides.
    const withoutShell = BOUND.filter((name) => name !== SHELL_TOOL_NAME);
    const gated = resolveGatedToolNames({
      rung: 'read-only',
      gateShell: false,
      boundToolNames: withoutShell,
    });
    expect(gated).not.toContain(SHELL_TOOL_NAME);
    expect([...gated].sort()).toEqual(
      [...WRITE_BUILT_INS, ...UNCLASSED.filter((n) => n !== SHELL_TOOL_NAME)].sort() as string[]
    );
  });

  it('gates a BOUND shell at a deterministic rung even when gateShell is false', () => {
    // Not a scenario production reaches (a disabled shell tool is never bound), but the rule must
    // hold by class rather than by tool identity: an unstated exemption for one name is the defect
    // class this node exists to remove. `gateShell` widens the set; it never narrows it.
    expect(gatedAt('read-only', false)).toContain(SHELL_TOOL_NAME);
    expect(gatedAt('write', false)).toContain(SHELL_TOOL_NAME);
  });

  it('gates an MCP tool that declares readOnlyHint exactly like one that does not', () => {
    for (const rung of ['read-only', 'write'] as const) {
      expect(gatedAt(rung)).toContain('mcp__docs__search');
      expect(gatedAt(rung)).toContain('mcp__jira__create_issue');
    }
  });

  it('gates move_file at read-only', () => {
    expect(gatedAt('read-only')).toContain('move_file');
  });

  it("gates deepagents' execute at both deterministic rungs", () => {
    expect(gatedAt('read-only')).toContain('execute');
    expect(gatedAt('write')).toContain('execute');
  });

  it('gates the internal bookkeeping tools too — no unstated exemption', () => {
    for (const name of [
      'gth_checklist',
      'gth_status_update',
      'gth_web_fetch',
      'show_a2ui_surface',
    ]) {
      expect(gatedAt('read-only')).toContain(name);
      expect(gatedAt('write')).toContain(name);
    }
  });

  it('never gates a bound tool the rung grants', () => {
    for (const name of READ_BUILT_INS) {
      expect(gatedAt('read-only')).not.toContain(name);
      expect(gatedAt('write')).not.toContain(name);
    }
    for (const name of WRITE_BUILT_INS) {
      expect(gatedAt('write')).not.toContain(name);
    }
  });

  it('gates only tools that are actually bound', () => {
    const gated = resolveGatedToolNames({
      rung: 'read-only',
      gateShell: false,
      boundToolNames: ['read_file', 'write_file'],
    });
    expect(gated).toEqual(['write_file']);
  });

  it('puts the shell first and otherwise keeps bound order, collapsing duplicates', () => {
    const gated = resolveGatedToolNames({
      rung: 'read-only',
      gateShell: true,
      boundToolNames: ['edit_file', SHELL_TOOL_NAME, 'my_custom_tool', 'edit_file'],
    });
    expect(gated).toEqual([SHELL_TOOL_NAME, 'edit_file', 'my_custom_tool']);
  });

  it('ignores nameless entries', () => {
    const gated = resolveGatedToolNames({
      rung: 'read-only',
      gateShell: false,
      boundToolNames: ['', 'edit_file'],
    });
    expect(gated).toEqual(['edit_file']);
  });
});

describe('EXT-80 — isToolGatedAtRung, asked about ONE call', () => {
  /**
   * **This is what `GthAgentRunner.decideToolApproval` consults, and it takes no bound toolset on
   * purpose.** The runner sees the names the graph reported registering, and on the deep backend
   * that list omits tools deepagents registers itself — `execute` above all. A decision that
   * consulted a bound list would grant deepagents' shell at `read-only` purely because the runner
   * could not see it.
   */
  it("gates deepagents' execute at the deterministic rungs with no bound set in play", () => {
    expect(isToolGatedAtRung({ toolName: 'execute', rung: 'read-only', gateShell: false })).toBe(
      true
    );
    expect(isToolGatedAtRung({ toolName: 'execute', rung: 'write', gateShell: false })).toBe(true);
  });

  it('gates the shell at EVERY rung when the shell gate is on', () => {
    for (const rung of APPROVAL_RUNGS) {
      expect(isToolGatedAtRung({ toolName: SHELL_TOOL_NAME, rung, gateShell: true })).toBe(true);
    }
  });

  it('gates nothing but the shell at the rated rungs and bypass', () => {
    for (const rung of ['auto-safe', 'full-auto', 'bypass'] as const) {
      for (const name of [...WRITE_BUILT_INS, ...UNCLASSED.filter((n) => n !== SHELL_TOOL_NAME)]) {
        expect(isToolGatedAtRung({ toolName: name, rung, gateShell: true })).toBe(false);
      }
    }
  });

  it('agrees name for name with the set resolver, at every rung', () => {
    // The projection property: the resolver is this predicate applied over the bound names, so a
    // second rule inlined into either one shows up here.
    for (const rung of APPROVAL_RUNGS) {
      const gated = gatedAt(rung);
      for (const name of BOUND) {
        expect(isToolGatedAtRung({ toolName: name, rung, gateShell: true })).toBe(
          gated.includes(name)
        );
      }
    }
  });
});

describe('EXT-80 — resolveInterruptToolNames: the rung-independent interrupt set', () => {
  const wired = (gateShell = true): readonly string[] =>
    resolveInterruptToolNames({ gateShell, boundToolNames: BOUND });

  /**
   * **The property the mid-session `/approvals` switch rests on.** The interrupt is installed once,
   * when the graph is built; the rung moves under it afterwards. Anything a rung could gate has to
   * be in it already, or that rung cannot gate it however hard the runner tries.
   */
  it('is a superset of what every rung gates', () => {
    for (const rung of APPROVAL_RUNGS) {
      for (const name of gatedAt(rung)) {
        expect(wired(), `${name} is gated at ${rung} but never interrupted`).toContain(name);
      }
    }
  });

  it('equals the read-only gated set, since read-only is the strictest rung', () => {
    expect([...wired()].sort()).toEqual([...gatedAt('read-only')].sort());
  });

  it('leaves out the read built-ins, which no rung gates', () => {
    for (const name of READ_BUILT_INS) {
      expect(wired()).not.toContain(name);
    }
  });

  it('holds the write built-ins, MCP, custom and bookkeeping tools whatever the rung in force is', () => {
    for (const name of [...WRITE_BUILT_INS, ...UNCLASSED]) {
      expect(wired()).toContain(name);
    }
  });

  it('is non-empty for a chat session with no shell gate, so read-only stays reachable there', () => {
    const chatTools = ['read_file', 'mcp__docs__search', 'my_custom_tool'];
    expect(resolveInterruptToolNames({ gateShell: false, boundToolNames: chatTools })).toEqual([
      'mcp__docs__search',
      'my_custom_tool',
    ]);
  });

  it('puts the shell first and otherwise keeps bound order, collapsing duplicates', () => {
    expect(
      resolveInterruptToolNames({
        gateShell: true,
        boundToolNames: ['edit_file', SHELL_TOOL_NAME, 'read_file', 'my_custom_tool', 'edit_file'],
      })
    ).toEqual([SHELL_TOOL_NAME, 'edit_file', 'my_custom_tool']);
  });
});

describe('EXT-80 — the gated set and isGrantedAtRung cannot disagree', () => {
  // The invariant that stops a later change reintroducing the drift: whatever the resolver decides,
  // the grant decision agrees with it, in BOTH directions.
  it.each([...APPROVAL_RUNGS])('at %s', (rung) => {
    const gated = gatedAt(rung);
    for (const name of gated) {
      // `bypass` is the one rung that grants a gated tool, and it does so by design (§2.5).
      expect(isGrantedAtRung(name, rung, gated)).toBe(rung === 'bypass');
    }
    for (const name of BOUND) {
      if (gated.includes(name)) continue;
      expect(isGrantedAtRung(name, rung, gated)).toBe(true);
    }
  });

  it('reports every non-read built-in as NOT granted at read-only', () => {
    const gated = gatedAt('read-only');
    for (const name of [...WRITE_BUILT_INS, ...UNCLASSED]) {
      expect(isGrantedAtRung(name, 'read-only', gated)).toBe(false);
    }
    for (const name of READ_BUILT_INS) {
      expect(isGrantedAtRung(name, 'read-only', gated)).toBe(true);
    }
  });

  it('reports the write built-ins as granted at write but not at read-only', () => {
    for (const name of WRITE_BUILT_INS) {
      expect(isGrantedAtRung(name, 'read-only', gatedAt('read-only'))).toBe(false);
      expect(isGrantedAtRung(name, 'write', gatedAt('write'))).toBe(true);
    }
  });

  /**
   * The composition `GthAgentRunner.getGrantedBuiltInTools` performs for the rater's §4.4
   * granted-alternative list: resolve the gated set for the rung in force, then report grants
   * against it. Pinned here rather than through the runner because the rater is consulted only at
   * the RATED rungs, so no runtime path reaches this composition at `read-only` today — the
   * property is structural, and this is what keeps it true if EXT-30 widens the rater.
   *
   * What it must never do is offer the model a tool the gate would stop: the rater suggesting
   * `write_file` at `read-only` would be suggesting the one thing guaranteed to interrupt the user.
   */
  it('never offers a rater alternative the gate would escalate', () => {
    const registered = ['read_file', 'gth_grep', 'write_file', 'edit_file', SHELL_TOOL_NAME];
    for (const rung of APPROVAL_RUNGS) {
      const gated = resolveGatedToolNames({ rung, gateShell: true, boundToolNames: registered });
      const offered = describeGrantedBuiltInTools(registered, rung, gated).map((t) => t.name);
      for (const name of offered) {
        expect(isGrantedAtRung(name, rung, gated)).toBe(true);
      }
    }
  });

  it('drops the write built-ins from the rater alternatives at read-only, keeps them at write', () => {
    const registered = ['read_file', 'gth_grep', 'write_file', 'edit_file', SHELL_TOOL_NAME];
    const offeredAt = (rung: ApprovalRung): string[] =>
      describeGrantedBuiltInTools(
        registered,
        rung,
        resolveGatedToolNames({ rung, gateShell: true, boundToolNames: registered })
      ).map((t) => t.name);

    expect(offeredAt('read-only')).toEqual(['read_file', 'gth_grep']);
    expect(offeredAt('write')).toEqual(['read_file', 'gth_grep', 'write_file', 'edit_file']);
  });
});
