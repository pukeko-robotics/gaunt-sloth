import { describe, expect, it } from 'vitest';
import { parseChecklistArgs, CHECKLIST_TOOL_NAME } from '#src/tui/viewModel.js';

describe('viewModel — checklist parsing', () => {
  it('exposes the checklist tool name', () => {
    expect(CHECKLIST_TOOL_NAME).toBe('gth_checklist');
  });

  it('parses a complete args buffer into typed rows', () => {
    const args = JSON.stringify({
      items: [
        { content: 'a', status: 'completed' },
        { content: 'b', status: 'in_progress' },
        { content: 'c', status: 'pending' },
      ],
    });
    expect(parseChecklistArgs(args)).toEqual([
      { content: 'a', status: 'completed' },
      { content: 'b', status: 'in_progress' },
      { content: 'c', status: 'pending' },
    ]);
  });

  it('returns null for an empty or half-streamed buffer (never throws)', () => {
    expect(parseChecklistArgs('')).toBeNull();
    expect(parseChecklistArgs('   ')).toBeNull();
    expect(parseChecklistArgs('{"items":[{"content":"a","stat')).toBeNull();
  });

  it('drops malformed rows but keeps valid ones', () => {
    const args = JSON.stringify({
      items: [
        { content: 'ok', status: 'pending' },
        { content: 'bad-status', status: 'nope' },
        { status: 'pending' },
        { content: 'also-ok', status: 'completed' },
      ],
    });
    expect(parseChecklistArgs(args)).toEqual([
      { content: 'ok', status: 'pending' },
      { content: 'also-ok', status: 'completed' },
    ]);
  });

  it('returns null when items is missing or not an array', () => {
    expect(parseChecklistArgs('{"items":"x"}')).toBeNull();
    expect(parseChecklistArgs('{}')).toBeNull();
    expect(parseChecklistArgs('{"items":[]}')).toBeNull();
  });
});
