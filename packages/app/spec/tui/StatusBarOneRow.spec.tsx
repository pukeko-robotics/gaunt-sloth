import { describe, expect, it } from 'vitest';
import React from 'react';
import { EventEmitter } from 'node:events';
import { render as inkRender } from 'ink';
import stripAnsi from 'strip-ansi';
import { StatusBar, statusBarRow } from '#src/tui/components/StatusBar.js';

/**
 * TUI-C92 — **the status bar is one row at every width, and it gives things up in a fixed order.**
 *
 * The dock's row budget counts the bar as one row, and a bar that wraps takes the second row out
 * of the conversation's floor without the budget knowing. So the bar is made unable to wrap
 * (DL-7): the render truncates, and the pure `statusBarRow` decides what to sacrifice first so
 * that truncation is the last resort rather than the first. The order — provider, then the rater
 * profile on the approvals badge, then `…` — is asserted at four widths, each one step narrower,
 * and the `⚡ Bypass` badge is asserted intact at every width the bar is designed for, because it
 * is the one badge whose absence would misreport a posture with no gate at all.
 *
 * Widths are chosen from the measured strings: the segments with the provider are 69 cells and
 * without it 56; the full badge is 37, the short one 24, the bypass badge 10.
 */

/** A stdout with a width, so the row's fit is decided at the width the spec names. */
class SizedStdout extends EventEmitter {
  frames: string[] = [];
  rows = 24;
  constructor(public columns: number) {
    super();
  }
  write = (frame: string) => {
    this.frames.push(frame);
  };
  lastFrame = () => this.frames[this.frames.length - 1];
}

class FakeStdin extends EventEmitter {
  isTTY = true;
  setEncoding() {}
  setRawMode() {}
  resume() {}
  pause() {}
  ref() {}
  unref() {}
  read = () => null;
}

/** The bar's frame at `columns`, ANSI stripped, as rows. */
function barRowsAt(columns: number, node: React.ReactElement): string[] {
  const stdout = new SizedStdout(columns);
  const instance = inkRender(node, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: new FakeStdin() as unknown as NodeJS.ReadStream,
    debug: true,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  const rows = stripAnsi(stdout.lastFrame() ?? '').split('\n');
  instance.unmount();
  return rows;
}

const input = {
  mode: 'code',
  modelDisplayName: 'claude-sonnet-4-5',
  modelProviderType: 'openrouter',
  turnCount: 2,
};
const WITH_PROVIDER = 'code  ·  model: claude-sonnet-4-5 (openrouter)  ·  turns: 2  ·  ready';
const BARE = 'code  ·  model: claude-sonnet-4-5  ·  turns: 2  ·  ready';
const FULL_BADGE = '  ·  approvals: Assisted (auto-rater)';
const SHORT_BADGE = '  ·  approvals: Assisted';
const BYPASS = ' ⚡ Bypass';

const assisted = { rung: 'assisted' as const };
const bypass = { rung: 'bypass' as const };

const bar = (columns: number, approvals: { rung: 'assisted' | 'bypass' }) => (
  <StatusBar running={false} {...input} columns={columns} approvals={approvals} />
);

describe('the status bar gives way in order and stays one row (TUI-C92)', () => {
  it('120 columns: everything fits, nothing is sacrificed', () => {
    expect(statusBarRow({ ...input, columns: 120, approvals: assisted })).toEqual({
      segments: WITH_PROVIDER,
      badge: FULL_BADGE,
    });
    expect(barRowsAt(120, bar(120, assisted))).toEqual([`${WITH_PROVIDER}${FULL_BADGE}`]);
    expect(barRowsAt(120, bar(120, bypass))).toEqual([`${WITH_PROVIDER}${BYPASS}`]);
  });

  it('100 columns: the provider goes first, the rater profile stays', () => {
    expect(statusBarRow({ ...input, columns: 100, approvals: assisted })).toEqual({
      segments: BARE,
      badge: FULL_BADGE,
    });
    expect(barRowsAt(100, bar(100, assisted))).toEqual([`${BARE}${FULL_BADGE}`]);
    expect(barRowsAt(100, bar(100, bypass))).toEqual([`${WITH_PROVIDER}${BYPASS}`]);
  });

  it('85 columns: the rater profile goes second, the badge still says the rung', () => {
    expect(statusBarRow({ ...input, columns: 85, approvals: assisted })).toEqual({
      segments: BARE,
      badge: SHORT_BADGE,
    });
    // Exactly, not `toContain`: a badge that kept its profile would be truncated here instead,
    // and `approvals: Assisted` would still be in the row.
    expect(barRowsAt(85, bar(85, assisted))).toEqual([`${BARE}${SHORT_BADGE}`]);
    expect(barRowsAt(85, bar(85, bypass))).toEqual([`${WITH_PROVIDER}${BYPASS}`]);
  });

  it('70 columns: only then the badge truncates with …, and the model is untouched', () => {
    // The pure decision has nothing left to drop; the render truncates the badge, never the
    // segments, because the segments refuse to shrink.
    expect(statusBarRow({ ...input, columns: 70, approvals: assisted })).toEqual({
      segments: BARE,
      badge: SHORT_BADGE,
    });
    const rows = barRowsAt(70, bar(70, assisted));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toBe(`${BARE}  ·  approval…`);
    expect(rows[0]).toHaveLength(70);
    // The bypass badge is ten cells and fits beside the bare segments here: intact.
    expect(barRowsAt(70, bar(70, bypass))).toEqual([`${BARE}${BYPASS}`]);
  });

  it('50 columns, narrower than the segments themselves: still one row, ending in …', () => {
    const rows = barRowsAt(50, bar(50, assisted));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveLength(50);
    expect(rows[0]).toMatch(/…$/);
    expect(rows[0].startsWith('code  ·  model: claude-sonnet-4-5')).toBe(true);
  });

  it('keeps the ⚡ Bypass badge at 80 columns with a 26-cell model id', () => {
    const rows = barRowsAt(
      80,
      <StatusBar
        running={false}
        mode="chat"
        modelDisplayName="claude-sonnet-4-5-20250929"
        modelProviderType="anthropic"
        turnCount={0}
        columns={80}
        approvals={bypass}
      />
    );
    expect(rows).toEqual([
      'chat  ·  model: claude-sonnet-4-5-20250929  ·  turns: 0  ·  ready ⚡ Bypass',
    ]);
  });

  it('reserves the debug hint in the decision, and truncates it too', () => {
    // 93 cells of segments and full badge fit 110 columns alone; with the 27-cell hint they are
    // 120 and do not, so the profile goes — the decision sees the hint.
    expect(statusBarRow({ ...input, columns: 110, approvals: assisted, debugHint: true })).toEqual({
      segments: BARE,
      badge: SHORT_BADGE,
    });
    expect(
      barRowsAt(
        110,
        <StatusBar running={false} {...input} columns={110} approvals={assisted} debugHint />
      )
    ).toEqual([`${BARE}${SHORT_BADGE}  ·  Tab: focus debug panel`]);
    // Narrower still: the badge and the hint share the shrink; the row is still one row.
    const rows = barRowsAt(
      70,
      <StatusBar running={false} {...input} columns={70} approvals={assisted} debugHint />
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveLength(70);
    expect(rows[0].startsWith(BARE)).toBe(true);
  });

  it('keeps the running row to one row by the same means', () => {
    // Wide: the spinner, the interrupt hint and the badge, on one row.
    const wide = barRowsAt(
      120,
      <StatusBar running mode="code" turnCount={2} columns={120} approvals={assisted} />
    );
    expect(wide).toHaveLength(1);
    expect(wide[0]).toContain('Thinking… (Esc to interrupt)');
    expect(wide[0]).toContain('approvals: Assisted');
    // Narrow: the badge truncates; the hint is the part that refuses to shrink.
    const narrow = barRowsAt(
      40,
      <StatusBar running mode="code" turnCount={2} columns={40} approvals={assisted} />
    );
    expect(narrow).toHaveLength(1);
    expect(narrow[0]).toContain('Thinking… (Esc to interrupt)');
    expect(narrow[0]).toHaveLength(40);
    expect(narrow[0]).toMatch(/…$/);
    // Narrower than the interrupt hint itself (30 cells): the hint truncates rather than wraps,
    // which is the case the badge's truncation cannot cover for it.
    const tiny = barRowsAt(
      20,
      <StatusBar running mode="code" turnCount={2} columns={20} approvals={assisted} />
    );
    expect(tiny).toHaveLength(1);
    expect(tiny[0]).toHaveLength(20);
    expect(tiny[0]).toMatch(/^. Thinking… \(Esc to…$/);
  });

  it('spells every badge the same with or without a profile to drop', () => {
    // No profile: the short and full spellings coincide, and the row is the same at every width.
    for (const rung of ['manual', 'write'] as const) {
      const row = statusBarRow({ ...input, columns: 80, approvals: { rung } });
      expect(row.badge).toMatch(/^ {2}· {2}approvals: /);
      expect(row.badge).not.toContain('(');
    }
    // A named rater profile is what the full spelling carries.
    expect(
      statusBarRow({ ...input, columns: 200, approvals: { rung: 'auto', raterProfile: 'strict' } })
        .badge
    ).toBe('  ·  approvals: Auto (strict)');
    // No approvals surface at all: no badge, and the decision degrades to the segments alone.
    expect(statusBarRow({ ...input, columns: 200 })).toEqual({ segments: WITH_PROVIDER });
  });
});
