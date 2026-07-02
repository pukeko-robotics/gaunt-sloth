import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GthConfig } from '@gaunt-sloth/core/config.js';

// B5: resolveAgentFactory picks the deep or lean factory from config. Mock the two concrete
// factories with sentinels so the test asserts the SELECTION, not the (heavy) agent construction.
const deepFactorySentinel = vi.fn();
const leanFactorySentinel = vi.fn();

vi.mock('#src/core/gthDeepAgentFactory.js', () => ({
  gthDeepAgentFactory: deepFactorySentinel,
}));
vi.mock('@gaunt-sloth/core/core/gthLeanAgentFactory.js', () => ({
  gthLeanAgentFactory: leanFactorySentinel,
}));

const cfg = (backend?: 'deep' | 'lean'): GthConfig =>
  ({ agent: backend ? { backend } : undefined }) as Partial<GthConfig> as GthConfig;

describe('resolveAgentFactory (B5)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns the deep factory when agent.backend is 'deep' (regardless of default)", async () => {
    const { resolveAgentFactory } = await import('#src/core/resolveAgentFactory.js');
    expect(resolveAgentFactory(cfg('deep'), 'lean')).toBe(deepFactorySentinel);
    expect(resolveAgentFactory(cfg('deep'), 'deep')).toBe(deepFactorySentinel);
  });

  it("returns the lean factory when agent.backend is 'lean' (regardless of default)", async () => {
    const { resolveAgentFactory } = await import('#src/core/resolveAgentFactory.js');
    expect(resolveAgentFactory(cfg('lean'), 'deep')).toBe(leanFactorySentinel);
    expect(resolveAgentFactory(cfg('lean'), 'lean')).toBe(leanFactorySentinel);
  });

  it('falls back to the per-command default when agent.backend is unset', async () => {
    const { resolveAgentFactory } = await import('#src/core/resolveAgentFactory.js');
    // interactive code/chat default: deep
    expect(resolveAgentFactory(cfg(), 'deep')).toBe(deepFactorySentinel);
    // single-shot ask/exec default: lean
    expect(resolveAgentFactory(cfg(), 'lean')).toBe(leanFactorySentinel);
  });

  it('treats a config with no agent block as unset (uses the default)', async () => {
    const { resolveAgentFactory } = await import('#src/core/resolveAgentFactory.js');
    const bare = {} as GthConfig;
    expect(resolveAgentFactory(bare, 'deep')).toBe(deepFactorySentinel);
    expect(resolveAgentFactory(bare, 'lean')).toBe(leanFactorySentinel);
  });
});
