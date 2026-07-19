import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import type { GthConfig } from '@gaunt-sloth/core/config.js';

// Text-path collaborators are mocked (per AGENTS.md) so the no-schema agent() path can be asserted
// without a live LLM — same modules/pattern evalCommand.spec.ts mocks.
const runSingleShot = vi.fn();
vi.mock('@gaunt-sloth/core/runtime/singleShot.js', () => ({ runSingleShot }));

const createResolvers = vi.fn();
vi.mock('@gaunt-sloth/agent/resolvers.js', () => ({ createResolvers }));

const resolveAgentFactory = vi.fn();
vi.mock('@gaunt-sloth/agent/core/resolveAgentFactory.js', () => ({ resolveAgentFactory }));

/** Absolute path to a workflow fixture script. */
function fixture(name: string): string {
  return fileURLToPath(new URL(`./fixtures/workflow/${name}`, import.meta.url));
}

/**
 * A fake {@link GthConfig} whose `llm.withStructuredOutput(schema).invoke()` returns what the test
 * supplies — the same deterministic stand-in askStructured.spec.ts uses (the schema path calls the
 * REAL askStructured, so this is not a mock-testing-a-mock).
 */
function fakeConfig(invokeImpl: () => unknown): GthConfig {
  const structuredInvoke = vi.fn(async () => invokeImpl());
  const withStructuredOutput = vi.fn(() => ({ invoke: structuredInvoke }));
  return { llm: { withStructuredOutput } } as unknown as GthConfig;
}

/** Build the RunWorkflowOptions with no CLI overrides. */
function options(baseConfig: GthConfig, args: unknown = undefined) {
  return { baseConfig, commandLineConfigOverrides: {}, args };
}

describe('runWorkflow', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('agent({ schema }) returns the validated object (schema built from ctx.z, real askStructured)', async () => {
    const { runWorkflow } = await import('#src/workflow/runWorkflow.js');
    const config = fakeConfig(() => ({ name: 'ok' }));

    const result = await runWorkflow(fixture('schema-workflow.mjs'), options(config));

    expect(result).toEqual({ name: 'ok' });
  });

  it('agent({ schema }) throws when the structured call returns a non-conforming object', async () => {
    const { runWorkflow } = await import('#src/workflow/runWorkflow.js');
    const config = fakeConfig(() => ({ wrong: 'shape' }));

    await expect(runWorkflow(fixture('schema-workflow.mjs'), options(config))).rejects.toThrow(
      /unparseable/
    );
  });

  it('exposes ctx.z (the host zod) and a schema built from it parses', async () => {
    const { runWorkflow } = await import('#src/workflow/runWorkflow.js');

    const result = (await runWorkflow(
      fixture('ctx-shape.mjs'),
      options({} as GthConfig, {
        seen: true,
      })
    )) as Record<string, unknown>;

    expect(result.hasZ).toBe(true);
    expect(result.schemaBuiltFromCtxZParses).toBe(true);
    expect(result.agentType).toBe('function');
    expect(result.parallelType).toBe('function');
    expect(result.logType).toBe('function');
    expect(result.argsSeen).toEqual({ seen: true });
  });

  it('parallel runs all thunks, preserves input order, and maps a throwing thunk to null', async () => {
    const { runWorkflow } = await import('#src/workflow/runWorkflow.js');

    const result = await runWorkflow(fixture('parallel-workflow.mjs'), options({} as GthConfig));

    expect(result).toEqual(['a', null, 'c']);
  });

  it('exposes the parsed --args value as ctx.args', async () => {
    const { runWorkflow } = await import('#src/workflow/runWorkflow.js');
    const args = { topic: 'graph-recall', k: 3 };

    const result = await runWorkflow(fixture('args-workflow.mjs'), options({} as GthConfig, args));

    expect(result).toEqual(args);
  });

  it('resolves to the workflow return value (string case)', async () => {
    const { runWorkflow } = await import('#src/workflow/runWorkflow.js');

    const result = await runWorkflow(fixture('string-workflow.mjs'), options({} as GthConfig));

    expect(result).toBe('plain string result');
  });

  it('resolves to the workflow return value (object case)', async () => {
    const { runWorkflow } = await import('#src/workflow/runWorkflow.js');

    const result = await runWorkflow(fixture('object-workflow.mjs'), options({} as GthConfig));

    expect(result).toEqual({ a: 1, b: ['x', 'y'], nested: { ok: true } });
  });

  it('throws a clear error when the script has no function default export', async () => {
    const { runWorkflow } = await import('#src/workflow/runWorkflow.js');

    await expect(runWorkflow(fixture('no-default.mjs'), options({} as GthConfig))).rejects.toThrow(
      /default export/
    );
  });

  it('throws a clear error when the default export is not a function', async () => {
    const { runWorkflow } = await import('#src/workflow/runWorkflow.js');

    await expect(
      runWorkflow(fixture('not-a-function.mjs'), options({} as GthConfig))
    ).rejects.toThrow(/default export/);
  });

  it('text agent() (no schema) returns runSingleShot answer, cloning config + running lean/ask', async () => {
    const cleanupTools = vi.fn();
    createResolvers.mockReturnValue({ cleanupTools });
    resolveAgentFactory.mockReturnValue({ factory: true });
    runSingleShot.mockResolvedValue({ ok: true, answer: 'the answer' });

    const { runWorkflow } = await import('#src/workflow/runWorkflow.js');

    const result = await runWorkflow(
      fixture('text-workflow.mjs'),
      options({ llm: {} } as GthConfig)
    );

    expect(result).toBe('the answer');
    expect(runSingleShot).toHaveBeenCalledTimes(1);
    expect(runSingleShot).toHaveBeenCalledWith(
      expect.stringMatching(/^WORKFLOW-/),
      '',
      'do a thing',
      expect.objectContaining({ canInterruptInferenceWithEsc: false, writeOutputToFile: false }),
      expect.anything(),
      'ask',
      expect.anything()
    );
    expect(resolveAgentFactory).toHaveBeenCalledWith(expect.anything(), 'lean');
    expect(cleanupTools).toHaveBeenCalledTimes(1);
  });

  it('text agent() throws when runSingleShot reports failure, and still cleans up tools', async () => {
    const cleanupTools = vi.fn();
    createResolvers.mockReturnValue({ cleanupTools });
    resolveAgentFactory.mockReturnValue({});
    runSingleShot.mockResolvedValue({ ok: false });

    const { runWorkflow } = await import('#src/workflow/runWorkflow.js');

    await expect(
      runWorkflow(fixture('text-workflow.mjs'), options({ llm: {} } as GthConfig))
    ).rejects.toThrow(/agent run failed/);
    expect(cleanupTools).toHaveBeenCalledTimes(1);
  });
});
