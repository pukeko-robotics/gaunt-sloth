import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { ApprovalsPicker, pickerRowLabel } from '#src/tui/components/ApprovalsPicker.js';
import { approvalPostureChoices } from '@gaunt-sloth/agent/modules/slashCommands.js';
import { APPROVAL_RUNG_DESCRIPTIONS, APPROVAL_RUNG_LABELS } from '@gaunt-sloth/core/config.js';

const DOWN = '\x1b[B';
const UP = '\x1b[A';
const ENTER = '\r';
const ESC = '\x1b';
const CTRL_C = '\x03';

// Ink waits briefly after a lone \x1b to tell a bare Escape from the start of a CSI sequence.
const tick = () => new Promise((r) => setTimeout(r, 20));

/**
 * CFG-39 — the interactive `/approvals` picker.
 *
 * The rows are the four POSTURES; `write` is a modifier of Manual and deliberately has no row,
 * while staying settable via `/approvals write`. The copy is the modes' own descriptions, never
 * text authored by the menu.
 */
describe('tui <ApprovalsPicker> (CFG-39)', () => {
  it('renders the four postures and no Write row', () => {
    const { lastFrame } = render(
      <ApprovalsPicker
        choices={approvalPostureChoices('assisted')}
        onSelect={vi.fn()}
        onCancel={vi.fn()}
      />
    );
    const frame = lastFrame() ?? '';
    for (const label of ['Manual', 'Assisted', 'Auto', 'Bypass']) {
      expect(frame).toContain(label);
    }
    // The Write MODIFIER is mentioned as chrome, but never as a selectable row.
    expect(frame).toContain('/approvals write');
    expect(frame.split('\n').filter((l) => /^[❯ ]\s*[●○]\s+Write\b/.test(l.trim()))).toEqual([]);
  });

  it('marks the mode in force, and only that one', () => {
    const { lastFrame } = render(
      <ApprovalsPicker
        choices={approvalPostureChoices('auto')}
        onSelect={vi.fn()}
        onCancel={vi.fn()}
      />
    );
    const frame = lastFrame() ?? '';
    expect(frame).toMatch(/●\s+Auto\b/);
    expect((frame.match(/●/g) ?? []).length).toBe(1);
  });

  /**
   * On `write` no row is current — the session is genuinely not on any of the four postures, and a
   * highlighted Manual row would claim it was. The status notice reports `write` from its title.
   */
  it('marks NO row when the session is on the Write modifier', () => {
    const { lastFrame } = render(
      <ApprovalsPicker
        choices={approvalPostureChoices('write')}
        onSelect={vi.fn()}
        onCancel={vi.fn()}
      />
    );
    expect(lastFrame() ?? '').not.toContain('●');
  });

  it('takes its copy from APPROVAL_RUNG_DESCRIPTIONS rather than authoring its own', () => {
    for (const choice of approvalPostureChoices('manual')) {
      const label = pickerRowLabel(choice);
      expect(label).toContain(APPROVAL_RUNG_LABELS[choice.rung]);
      // The row shows the description's own first sentence, verbatim.
      expect(APPROVAL_RUNG_DESCRIPTIONS[choice.rung]).toContain(
        label.slice(label.indexOf('— ') + 2).replace(/\.$/, '')
      );
    }
  });

  it('starts on the mode in force, so Enter confirms it rather than silently changing it', async () => {
    const onSelect = vi.fn();
    const { stdin } = render(
      <ApprovalsPicker
        choices={approvalPostureChoices('auto')}
        onSelect={onSelect}
        onCancel={vi.fn()}
      />
    );
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(onSelect).toHaveBeenCalledWith('auto');
  });

  it('arrow keys move the selection and Enter reports the chosen mode', async () => {
    const onSelect = vi.fn();
    const { stdin } = render(
      <ApprovalsPicker
        choices={approvalPostureChoices('manual')}
        onSelect={onSelect}
        onCancel={vi.fn()}
      />
    );
    await tick();
    stdin.write(DOWN);
    await tick();
    stdin.write(ENTER);
    await tick();
    // Manual → Assisted is one step down the offered order.
    expect(onSelect).toHaveBeenCalledWith('assisted');
  });

  it('wraps upward from the first row to Bypass, the last posture', async () => {
    const onSelect = vi.fn();
    const { stdin } = render(
      <ApprovalsPicker
        choices={approvalPostureChoices('manual')}
        onSelect={onSelect}
        onCancel={vi.fn()}
      />
    );
    await tick();
    stdin.write(UP);
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(onSelect).toHaveBeenCalledWith('bypass');
  });

  it('Esc cancels without choosing anything — the mode is left as it was', async () => {
    const onSelect = vi.fn();
    const onCancel = vi.fn();
    const { stdin } = render(
      <ApprovalsPicker
        choices={approvalPostureChoices('assisted')}
        onSelect={onSelect}
        onCancel={onCancel}
      />
    );
    await tick();
    stdin.write(ESC);
    await tick();
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('Ctrl+C cancels too, and never reads as "picked the highlighted row"', async () => {
    const onSelect = vi.fn();
    const onCancel = vi.fn();
    const { stdin } = render(
      <ApprovalsPicker
        choices={approvalPostureChoices('assisted')}
        onSelect={onSelect}
        onCancel={onCancel}
      />
    );
    await tick();
    stdin.write(CTRL_C);
    await tick();
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
  });
});
