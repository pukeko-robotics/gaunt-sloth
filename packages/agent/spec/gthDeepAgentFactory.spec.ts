import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StatusLevel } from '@gaunt-sloth/core/core/types.js';

const gthDeepAgentCtor = vi.fn();
vi.mock('#src/core/GthDeepAgent.js', () => ({
  GthDeepAgent: vi.fn(function (this: unknown, ...args: unknown[]) {
    gthDeepAgentCtor(...args);
  }),
}));

describe('gthDeepAgentFactory', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('warns that the deep backend is experimental and constructs a GthDeepAgent', async () => {
    const { gthDeepAgentFactory } = await import('#src/core/gthDeepAgentFactory.js');
    const statusUpdate = vi.fn();
    const resolvers = { resolveTools: vi.fn() } as never;

    gthDeepAgentFactory(statusUpdate, resolvers);

    // The experimental warning is emitted at WARNING level, and mentions the backend.
    expect(statusUpdate).toHaveBeenCalledWith(
      StatusLevel.WARNING,
      expect.stringMatching(/experimental/i)
    );
    expect(statusUpdate.mock.calls[0][1]).toMatch(/deepagents/i);
    // And the deep agent is still built with the same statusUpdate + resolvers.
    expect(gthDeepAgentCtor).toHaveBeenCalledWith(statusUpdate, resolvers);
  });
});
