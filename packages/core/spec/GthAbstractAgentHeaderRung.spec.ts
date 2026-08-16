import { describe, expect, it } from 'vitest';
import type { GthConfig } from '#src/config.js';
import type { GthOutputHeaderRung } from '#src/config/schema.js';
import { GthAbstractAgent } from '#src/core/GthAbstractAgent.js';

/**
 * GS2-101 §2 — THE pin on which rung an unset `output.header` resolves to.
 *
 * It asserts on the resolved rung DIRECTLY rather than on anything the rung goes on to drive. Every
 * other test of the header reads a downstream effect — which lines `init` emitted, which flag
 * `waitForEscape` was passed — and a downstream assertion can only see the default through whatever
 * the rung happens to be wired to at the time. That is how the default drifted unnoticed across two
 * tickets: nothing named it, so nothing failed when it was wrong.
 *
 * It is on {@link GthAbstractAgent} because the read site is, so the pin does not depend on a
 * backend, a resolver, or `init` running at all.
 */
class TestAgent extends GthAbstractAgent {
  async init(): Promise<void> {
    /* not used — the rung is read off the config, not built during init */
  }

  /** Exposes the protected read site so the resolved value itself can be asserted. */
  rung(): GthOutputHeaderRung {
    return this.headerRung;
  }

  withConfig(output?: GthConfig['output']): this {
    this.config = (output ? { output } : {}) as GthConfig;
    return this;
  }
}

const agentWith = (output?: GthConfig['output']): TestAgent =>
  new TestAgent(() => {}).withConfig(output);

describe('GthAbstractAgent#headerRung — the run-header default (GS2-101 §2)', () => {
  it('resolves an unset output.header to compact', () => {
    expect(agentWith().rung()).toBe('compact');
  });

  it('resolves a present but empty output object to compact', () => {
    expect(agentWith({}).rung()).toBe('compact');
  });

  // Before init there is no config at all — the same default has to hold, or the very first thing
  // a half-built agent emitted would be graded by a rung nobody chose.
  it('resolves to compact when no config has been set at all', () => {
    expect(new TestAgent(() => {}).rung()).toBe('compact');
  });

  it.each(['none', 'compact', 'debug'] as const)(
    'resolves an explicit %s to itself',
    (header: GthOutputHeaderRung) => {
      expect(agentWith({ header }).rung()).toBe(header);
    }
  );
});
