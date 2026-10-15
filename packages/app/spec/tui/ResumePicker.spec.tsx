import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import {
  RESUME_PICKER_FOOTER,
  RESUME_PICKER_TITLE,
  ResumePicker,
  resumeCancelledNotice,
  resumeRowLabel,
} from '#src/tui/components/ResumePicker.js';
import type { ConversationSummary } from '@gaunt-sloth/core/history/historyStore.js';

const DOWN = '\x1b[B';
const UP = '\x1b[A';
const ENTER = '\r';
const ESC = '\x1b';

// Ink waits briefly after a lone \x1b to tell a bare Escape from the start of a CSI sequence.
const tick = () => new Promise((r) => setTimeout(r, 20));

function conversation(over: Partial<ConversationSummary> = {}): ConversationSummary {
  return {
    id: 12,
    startedTs: '2026-09-01T10:00:00.000Z',
    lastTs: '2026-09-01T10:30:00.000Z',
    command: 'chat',
    model: 'gemma4:12b',
    turnCount: 2,
    lastPrompt: 'what does the fold loop do',
    threadId: 'thread-12',
    ...over,
  };
}

const three = [
  conversation({ id: 12 }),
  conversation({ id: 34, command: 'code', lastPrompt: 'fix the flaky window test' }),
  conversation({ id: 56, turnCount: 1, lastPrompt: undefined }),
];

/**
 * GS2-112 — the bare-`/resume` picker.
 *
 * What is asserted here is the CHOICE, not the drawing: every keystroke case ends on the id
 * `onSelect` reported, because the id is what the parent resumes. A cell that only proved rows
 * appeared would pass over a picker wired to the wrong row — which is the defect this node exists
 * to prevent.
 */
describe('tui <ResumePicker> (GS2-112)', () => {
  it('renders one row per candidate, id first, with the controls line', () => {
    const { lastFrame } = render(
      <ResumePicker candidates={three} onSelect={vi.fn()} onCancel={vi.fn()} />
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain(RESUME_PICKER_TITLE);
    for (const id of ['#12', '#34', '#56']) expect(frame).toContain(id);
    expect(frame).toContain(RESUME_PICKER_FOOTER);
    // The highlight starts on the first row.
    expect(frame).toContain('❯ #12');
  });

  it('Enter with no movement resumes the first candidate', async () => {
    const onSelect = vi.fn();
    const { stdin } = render(
      <ResumePicker candidates={three} onSelect={onSelect} onCancel={vi.fn()} />
    );
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(onSelect.mock.calls).toEqual([[12]]);
  });

  /** The cell the mutation below is aimed at: the cursor, not the list order, decides. */
  it('arrow keys move the highlight and Enter resumes the highlighted conversation', async () => {
    const onSelect = vi.fn();
    const { stdin, lastFrame } = render(
      <ResumePicker candidates={three} onSelect={onSelect} onCancel={vi.fn()} />
    );
    await tick();
    stdin.write(DOWN);
    // Wait for the highlight to be ON the intended row — not merely for a `❯` to exist, which was
    // already true before the keystroke and would make this wait pass without it having landed.
    await vi.waitFor(() => expect(lastFrame()).toContain('❯ #34'));
    stdin.write(ENTER);
    await tick();
    expect(onSelect.mock.calls).toEqual([[34]]);
  });

  it('the highlight wraps upward to the last candidate', async () => {
    const onSelect = vi.fn();
    const { stdin, lastFrame } = render(
      <ResumePicker candidates={three} onSelect={onSelect} onCancel={vi.fn()} />
    );
    await tick();
    stdin.write(UP);
    await vi.waitFor(() => expect(lastFrame()).toContain('❯ #56'));
    stdin.write(ENTER);
    await tick();
    expect(onSelect.mock.calls).toEqual([[56]]);
  });

  it('Esc cancels on the first press and chooses nothing', async () => {
    const onSelect = vi.fn();
    const onCancel = vi.fn();
    const { stdin } = render(
      <ResumePicker candidates={three} onSelect={onSelect} onCancel={onCancel} />
    );
    await tick();
    stdin.write(ESC);
    await tick();
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
  });

  /**
   * Filtering is off, so a printable key is swallowed rather than narrowing the list — and the
   * first Esc still cancels. With it on, that keystroke would empty the list and Esc would be spent
   * clearing the filter, which is what the footer promises it is not.
   */
  it('typing does not filter the list, and does not consume the Esc that cancels', async () => {
    const onSelect = vi.fn();
    const onCancel = vi.fn();
    const { stdin, lastFrame } = render(
      <ResumePicker candidates={three} onSelect={onSelect} onCancel={onCancel} />
    );
    await tick();
    stdin.write('zzz');
    await tick();
    const frame = lastFrame() ?? '';
    for (const id of ['#12', '#34', '#56']) expect(frame).toContain(id);
    expect(frame).not.toContain('filter:');
    stdin.write(ESC);
    await tick();
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
  });

  describe('resumeRowLabel', () => {
    it('leads with the id and carries when, command, model, turn count and a preview', () => {
      const label = resumeRowLabel(conversation());
      expect(label.startsWith('#12  ')).toBe(true);
      expect(label).toContain('2026-09-01T10:30:00.000Z');
      expect(label).toContain('[chat]');
      expect(label).toContain('gemma4:12b');
      expect(label).toContain('(2 turns)');
      expect(label).toContain('what does the fold loop do');
    });

    it('is one line: the preview is clipped and its newlines collapsed', () => {
      const label = resumeRowLabel(
        conversation({ lastPrompt: `refactor\nthe ${'very '.repeat(20)}long prompt` })
      );
      expect(label).not.toContain('\n');
      expect(label).toContain('refactor the very');
      expect(label).toContain('…');
      expect(label.length).toBeLessThan(140);
    });

    it('drops the parts a conversation does not have, and falls back for the timestamp', () => {
      const label = resumeRowLabel({
        id: 7,
        startedTs: '2026-08-08T08:00:00.000Z',
        turnCount: 1,
      });
      expect(label).toBe('#7  2026-08-08T08:00:00.000Z  (1 turn)');
    });
  });

  it('the cancelled notice says nothing changed', () => {
    const notice = resumeCancelledNotice();
    expect(notice.title).toBe('Resume cancelled');
    expect(notice.lines.join(' ')).toContain('Nothing was changed.');
  });
});
