import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GthConfig } from '@gaunt-sloth/core/config.js';

/**
 * B5 / EXT-114 — `resolveAgentFactory` is the one place a backend is chosen, and there is one
 * backend to choose. What these cells pin is that the seam resolves to the LEAN factory on every
 * input, including the inputs that used to resolve to something else: an `agent.backend` value, a
 * per-command default, and an absent agent block.
 *
 * The lean factory is mocked with a sentinel so the assertion is about the SELECTION rather than
 * the (heavy) agent construction — and so a build that quietly reintroduced a second factory would
 * fail here rather than merely construct a different agent.
 */
const leanFactorySentinel = vi.fn();

vi.mock('@gaunt-sloth/core/core/gthLeanAgentFactory.js', () => ({
  gthLeanAgentFactory: leanFactorySentinel,
}));

const cfg = (backend?: 'lean'): GthConfig =>
  ({ agent: backend ? { backend } : undefined }) as Partial<GthConfig> as GthConfig;

describe('resolveAgentFactory (B5)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns the lean factory when agent.backend is 'lean'", async () => {
    const { resolveAgentFactory } = await import('#src/core/resolveAgentFactory.js');
    expect(resolveAgentFactory(cfg('lean'), 'lean')).toBe(leanFactorySentinel);
  });

  it('returns the lean factory when agent.backend is unset', async () => {
    const { resolveAgentFactory } = await import('#src/core/resolveAgentFactory.js');
    expect(resolveAgentFactory(cfg(), 'lean')).toBe(leanFactorySentinel);
  });

  it('treats a config with no agent block the same way', async () => {
    const { resolveAgentFactory } = await import('#src/core/resolveAgentFactory.js');
    expect(resolveAgentFactory({} as GthConfig, 'lean')).toBe(leanFactorySentinel);
  });

  /**
   * The retired value cannot reach here — config validation rejects `agent.backend: deep` outright
   * (EXT-114, `configSchema.spec.ts`). Should some caller construct one anyway, the seam must still
   * hand back a real agent rather than `undefined`: the resolved config is the runner's only input,
   * and a factory-shaped hole there is a crash at the first turn instead of a config error at load.
   */
  it('still resolves to lean for a retired backend value that bypassed validation', async () => {
    const { resolveAgentFactory } = await import('#src/core/resolveAgentFactory.js');
    const smuggled = { agent: { backend: 'deep' } } as unknown as GthConfig;
    expect(resolveAgentFactory(smuggled, 'lean')).toBe(leanFactorySentinel);
  });
});
