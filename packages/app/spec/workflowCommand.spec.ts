import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('parseWorkflowArgs', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('returns undefined when --args is omitted', async () => {
    const { parseWorkflowArgs } = await import('#src/commands/workflowCommand.js');
    expect(parseWorkflowArgs(undefined)).toBeUndefined();
  });

  it('parses a valid JSON object', async () => {
    const { parseWorkflowArgs } = await import('#src/commands/workflowCommand.js');
    expect(parseWorkflowArgs('{"topic":"x","k":3}')).toEqual({ topic: 'x', k: 3 });
  });

  it('parses a valid JSON scalar', async () => {
    const { parseWorkflowArgs } = await import('#src/commands/workflowCommand.js');
    expect(parseWorkflowArgs('42')).toBe(42);
  });

  it('throws a clear error (not a raw SyntaxError) on malformed JSON', async () => {
    const { parseWorkflowArgs } = await import('#src/commands/workflowCommand.js');
    expect(() => parseWorkflowArgs('{not json')).toThrow(/Invalid --args JSON/);
  });
});
