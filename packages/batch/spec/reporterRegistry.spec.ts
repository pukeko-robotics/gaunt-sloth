import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EvalReporter, EvalReporterFactory } from '#src/reporters/reporterTypes.js';

describe('reporter registry', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('resolves the built-in "text" reporter to an instance with the three lifecycle hooks', async () => {
    const { resolveReporters } = await import('#src/reporters/registry.js');

    const reporters = resolveReporters(['text']);

    expect(reporters).toHaveLength(1);
    expect(typeof reporters[0].onSuiteStart).toBe('function');
    expect(typeof reporters[0].onCellResult).toBe('function');
    expect(typeof reporters[0].onSuiteEnd).toBe('function');
  });

  it('instantiates a fresh reporter per call (factory, not singleton)', async () => {
    const { resolveReporters } = await import('#src/reporters/registry.js');

    const [a] = resolveReporters(['text']);
    const [b] = resolveReporters(['text']);

    expect(a).not.toBe(b);
  });

  it('lists the built-in names', async () => {
    const { availableReporterNames } = await import('#src/reporters/registry.js');
    expect(availableReporterNames()).toEqual(['text']);
  });

  it('throws on an unknown reporter name, quoting it and the available list', async () => {
    const { resolveReporters } = await import('#src/reporters/registry.js');

    expect(() => resolveReporters(['nope'])).toThrow(/unknown reporter "nope"/);
    expect(() => resolveReporters(['nope'])).toThrow(/text/);
  });

  it('overlays a custom reporter over the built-ins (A2 shape)', async () => {
    const { resolveReporters, availableReporterNames } = await import('#src/reporters/registry.js');
    const custom: EvalReporter = { onSuiteEnd: vi.fn() };
    const customMap: Record<string, EvalReporterFactory> = { junit: () => custom };

    expect(resolveReporters(['junit'], customMap)[0]).toBe(custom);
    expect(availableReporterNames(customMap)).toEqual(expect.arrayContaining(['text', 'junit']));
    // A custom map does not remove the built-ins.
    expect(resolveReporters(['text', 'junit'], customMap)).toHaveLength(2);
  });
});
