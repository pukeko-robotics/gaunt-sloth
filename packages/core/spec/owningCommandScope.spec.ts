/**
 * GS2-81 — `owningCommand` is a LABEL, and this file is what keeps it one.
 *
 * `GthAgentRunner.init` takes a `command` that is not a label: it selects the mode prompt
 * (`readModePrompt`), the per-command approvals posture (`resolveApprovals`) and the
 * command-specific filesystem config. A helper agent that must run on the chat prompt therefore
 * inits with `command: undefined`, and passes `owningCommand` alongside so its user-facing
 * messages can still name the verb the run belongs to.
 *
 * The two are one `??` apart, and collapsing them reads as an obvious tidy-up — the line that
 * emits a notice does exactly that. These cells drive a real `GthAgentRunner` with the real
 * `GthLangChainAgent` behind it and pin that the label reaches the message and NOTHING else.
 *
 * The only mock is `langchain`'s `createAgent`, the model-graph boundary: mocking it is also what
 * lets the agent's own construction be the evidence for what ran.
 */
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { GthConfig } from '#src/config.js';
import type { GthCommand, PendingToolInterrupt, StatusUpdateCallback } from '#src/core/types.js';

const createAgentMock = vi.fn();
vi.mock('langchain', async () => {
  const actual = await vi.importActual<typeof import('langchain')>('langchain');
  return { ...actual, createAgent: createAgentMock };
});

/**
 * Records what the runner asks the shell-approvals policy with, while keeping the real
 * implementation. `this.command` is that second argument, and it decides whether the shell tool is
 * gated at all and at which rung — so it is the field a label must never leak into.
 */
const resolveShellApprovalGateSpy = vi.fn();
vi.mock('#src/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('#src/config.js')>();
  return {
    ...actual,
    resolveShellApprovalGate: (...args: Parameters<typeof actual.resolveShellApprovalGate>) => {
      resolveShellApprovalGateSpy(...args);
      return actual.resolveShellApprovalGate(...args);
    },
  };
});

vi.mock('#src/middleware/registry.js', () => ({ resolveMiddleware: vi.fn(async () => []) }));

describe('GS2-81 — owningCommand labels the run without steering it', () => {
  let GthAgentRunner: typeof import('#src/core/GthAgentRunner.js').GthAgentRunner;
  let statusUpdate: Mock<StatusUpdateCallback>;

  /** A config the agent can initialize from, with no prompt files read off this machine. */
  const config = (): GthConfig =>
    ({
      llm: { _llmType: () => 'test', bindTools: vi.fn() },
      streamOutput: false,
      contentSource: 'file',
      requirementSource: 'file',
      filesystem: 'none',
      useColour: false,
      writeOutputToFile: false,
      writeBinaryOutputsToFile: false,
      streamSessionInferenceLog: false,
      canInterruptInferenceWithEsc: false,
      includeCurrentDateAfterGuidelines: false,
      noDefaultPrompts: true,
      output: { header: false },
    }) as unknown as GthConfig;

  const resolvers = { resolveTools: async () => [] };

  beforeEach(async () => {
    vi.resetAllMocks();
    createAgentMock.mockReturnValue({ invoke: vi.fn(), stream: vi.fn() });
    statusUpdate = vi.fn();
    ({ GthAgentRunner } = await import('#src/core/GthAgentRunner.js'));
  });

  /**
   * The mode prompt, and with it the command-specific filesystem config that rides on the same
   * `command` argument. Asserted as an equality against a run with no label at all: if the label
   * reached the agent, the composed prompt would differ.
   */
  it("never lets owningCommand reach the agent's command argument (the mode prompt)", async () => {
    const runner = new GthAgentRunner(statusUpdate, resolvers as never);
    await runner.init(undefined, config(), undefined, { owningCommand: 'pr' });

    expect(createAgentMock).toHaveBeenCalledTimes(1);
    const [[agentOptions]] = createAgentMock.mock.calls as [[{ systemPrompt?: string }]];

    const withoutLabel = vi.fn();
    createAgentMock.mockImplementation((options: unknown) => {
      withoutLabel(options);
      return { invoke: vi.fn(), stream: vi.fn() };
    });
    await new GthAgentRunner(statusUpdate, resolvers as never).init(undefined, config());
    const [[baselineOptions]] = withoutLabel.mock.calls as [[{ systemPrompt?: string }]];

    expect(agentOptions.systemPrompt).toEqual(baselineOptions.systemPrompt);
  });

  /**
   * The safety-relevant half. The runner keeps its own `this.command` and hands it to
   * `resolveShellApprovalGate`, which decides whether the shell tool is gated at all and under
   * which rung — including `bypass`. Rewriting that assignment to `command ?? options.owningCommand`
   * would make the `pr` discovery agent resolve its shell posture from `commands.pr`, so a user with
   * `commands.pr` on a bypass rung would get a discovery agent that stops asking before it runs
   * shell commands. Asserted at the policy call, not on the composed prompt, which cannot see it.
   */
  it('never lets owningCommand reach the shell-approvals posture', async () => {
    const runner = new GthAgentRunner(statusUpdate, resolvers as never);
    await runner.init(undefined, config(), undefined, { owningCommand: 'pr' });

    resolveShellApprovalGateSpy.mockClear();
    const decide = (
      runner as unknown as {
        decideToolApproval(tool: PendingToolInterrupt): Promise<unknown>;
      }
    ).decideToolApproval.bind(runner);
    await decide({ name: 'read_file', args: {} } as unknown as PendingToolInterrupt);

    expect(resolveShellApprovalGateSpy).toHaveBeenCalled();
    expect(resolveShellApprovalGateSpy.mock.calls[0][1]).toBeUndefined();
    // The field the policy reads is the one that must not have picked the label up.
    expect((runner as unknown as { command?: GthCommand }).command).toBeUndefined();
  });
});
