/**
 * [[EXT-80]] acceptance on the LEAN backend — **what the approval interrupt is actually wired
 * with**, asserted against the options `humanInTheLoopMiddleware` is called with rather than
 * against the gated set the agent computed. The set being right and the middleware being installed
 * with it are two different claims, and only the second one gates a real call.
 *
 * The sibling assertions for the deep backend live in `@gaunt-sloth/agent`'s `GthDeepAgent.spec.ts`;
 * the pure set resolution lives in `gatedToolSet.spec.ts`.
 */
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { GthConfig } from '#src/config.js';
import { SHELL_TOOL_NAME } from '#src/config.js';
import type { StatusUpdateCallback } from '#src/core/types.js';

vi.mock('#src/utils/consoleUtils.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('#src/utils/consoleUtils.js')>();
  return {
    ...actual,
    display: vi.fn(),
    displayInfo: vi.fn(),
    displayWarning: vi.fn(),
    displayError: vi.fn(),
    displaySuccess: vi.fn(),
    displayDebug: vi.fn(),
    displayToolIndication: vi.fn(),
  };
});

const createAgentMock = vi.fn();
const hitlMock = vi.fn();
vi.mock('langchain', async () => {
  const actual = await vi.importActual<typeof import('langchain')>('langchain');
  return {
    ...actual,
    createAgent: createAgentMock,
    humanInTheLoopMiddleware: (options: unknown) => {
      hitlMock(options);
      return { name: 'humanInTheLoop' };
    },
  };
});

vi.mock('#src/middleware/registry.js', () => ({ resolveMiddleware: vi.fn(async () => []) }));

describe('EXT-80 — the lean backend wires the interrupt on the whole gated set', () => {
  let GthLangChainAgent: typeof import('#src/core/GthLangChainAgent.js').GthLangChainAgent;
  let statusUpdate: Mock<StatusUpdateCallback>;

  /**
   * A toolset spanning every class that behaves differently: a granted read built-in, a write
   * built-in (including `move_file`, which the node prose omits), the shell, an MCP tool declaring
   * `readOnlyHint: true`, a custom tool, and an internal bookkeeping tool.
   */
  const tools = [
    { name: 'read_file', description: 'Read one file.' },
    { name: 'list_directory', description: 'List a directory.' },
    { name: 'write_file', description: 'Write a file.' },
    { name: 'edit_file', description: 'Edit a file.' },
    { name: 'create_directory', description: 'Create a directory.' },
    { name: 'move_file', description: 'Move a file.' },
    { name: 'delete_file', description: 'Delete a file.' },
    { name: 'delete_directory', description: 'Delete a directory.' },
    { name: SHELL_TOOL_NAME, description: 'Run a shell command.' },
    {
      name: 'mcp__docs__search',
      description: 'Search the docs.',
      metadata: { mcp: { serverName: 'docs', annotations: { readOnlyHint: true } } },
    },
    { name: 'my_custom_tool', description: 'Do a custom thing.' },
    { name: 'gth_checklist', description: 'Track a checklist.' },
  ];

  const resolvers = { resolveTools: async () => tools.map((t) => ({ ...t })) };

  const baseConfig = (): GthConfig =>
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
      output: { header: false },
    }) as unknown as GthConfig;

  /** The tool names actually wired into the approval interrupt, or null when none was installed. */
  function wiredInterruptNames(): string[] | null {
    if (hitlMock.mock.calls.length === 0) return null;
    const options = hitlMock.mock.calls.at(-1)![0] as { interruptOn: Record<string, unknown> };
    return Object.keys(options.interruptOn).sort();
  }

  const initAt = async (rung: string, command: 'code' | 'chat' = 'code'): Promise<void> => {
    const agent = new GthLangChainAgent(statusUpdate, resolvers as never);
    await agent.init(command, { ...baseConfig(), approvals: rung } as unknown as GthConfig);
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    createAgentMock.mockReturnValue({ invoke: vi.fn(), stream: vi.fn() });
    statusUpdate = vi.fn();
    ({ GthLangChainAgent } = await import('#src/core/GthLangChainAgent.js'));
  });

  it('gates every write built-in, the shell, MCP and custom tools at read-only', async () => {
    await initAt('read-only');

    expect(wiredInterruptNames()).toEqual([
      'create_directory',
      'delete_directory',
      'delete_file',
      'edit_file',
      'gth_checklist',
      'mcp__docs__search',
      'move_file',
      'my_custom_tool',
      SHELL_TOOL_NAME,
      'write_file',
    ]);
  });

  it('leaves the read built-ins ungated at read-only', async () => {
    await initAt('read-only');

    expect(wiredInterruptNames()).not.toContain('read_file');
    expect(wiredInterruptNames()).not.toContain('list_directory');
  });

  it('frees the write built-ins at write but keeps the shell, MCP and custom tools gated', async () => {
    await initAt('write');

    expect(wiredInterruptNames()).toEqual([
      'gth_checklist',
      'mcp__docs__search',
      'my_custom_tool',
      SHELL_TOOL_NAME,
    ]);
  });

  it.each(['auto-safe', 'full-auto', 'bypass'] as const)(
    'wires the shell and nothing else at %s — unchanged behaviour',
    async (rung) => {
      await initAt(rung);

      expect(wiredInterruptNames()).toEqual([SHELL_TOOL_NAME]);
    }
  );

  it('installs no middleware at all at a rated rung with no shell gate', async () => {
    // `chat` emits no dev tools, so the shell gate is off and the rated rungs gate nothing.
    await initAt('auto-safe', 'chat');

    expect(wiredInterruptNames()).toBeNull();
  });

  it('installs the middleware at read-only on chat, where there is no shell gate to key off', async () => {
    await initAt('read-only', 'chat');

    const wired = wiredInterruptNames();
    expect(wired).not.toBeNull();
    expect(wired).toContain('mcp__docs__search');
    expect(wired).toContain('write_file');
    expect(wired).toContain('my_custom_tool');
  });

  it('wires approve/reject on every gated tool, not just the shell', async () => {
    await initAt('read-only');

    const options = hitlMock.mock.calls.at(-1)![0] as {
      interruptOn: Record<string, unknown>;
    };
    for (const value of Object.values(options.interruptOn)) {
      expect(value).toEqual({ allowedDecisions: ['approve', 'reject'] });
    }
  });

  it('suffixes exactly the tools it gates, and no others', async () => {
    // §4.5's non-drift property, asserted end to end on the real init: the descriptions the model
    // reads and the set the interrupt holds are the same set.
    await initAt('read-only');

    const params = createAgentMock.mock.calls.at(-1)![0] as {
      tools: { name: string; description: string }[];
    };
    const suffixed = params.tools
      .filter((t) => t.description.includes("will require the user's approval"))
      .map((t) => t.name)
      .sort();

    expect(suffixed).toEqual(wiredInterruptNames());
  });
});
