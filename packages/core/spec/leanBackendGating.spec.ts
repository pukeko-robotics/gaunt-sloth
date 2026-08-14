/**
 * [[EXT-80]] acceptance on the LEAN backend — **what the approval interrupt is actually wired
 * with**, asserted against the options `humanInTheLoopMiddleware` is called with rather than
 * against the set the agent computed. The set being right and the middleware being installed with it
 * are two different claims, and only the second one gates a real call.
 *
 * **The interrupt is wired rung-INDEPENDENTLY** — every tool any rung could gate — because it is
 * installed once, here, while `/approvals <rung>` moves the rung for the rest of the session. The
 * rung is decided per call by `GthAgentRunner.decideToolApproval`, so what a rung actually gates is
 * asserted where that happens (`approvalRungTransition.spec.ts`, on a real graph through the real
 * runner), and this file asserts the wiring the transition depends on. Reading only this file would
 * suggest the rated rungs gate more than they do; reading only that one would not prove the
 * interrupt reaches a non-shell tool at all.
 *
 * The §4.5 tool DESCRIPTIONS follow the live rung instead, so they are the one thing here that still
 * differs per rung — a description promising an approval the runner will not ask for is the drift
 * §4.5 calls worse than no description at all.
 *
 * The pure set resolution lives in `gatedToolSet.spec.ts`.
 */
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { GthConfig } from '#src/config.js';
import { APPROVAL_RUNGS, RUNG_TOOL_DESCRIPTION_SUFFIXES, SHELL_TOOL_NAME } from '#src/config.js';
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
      output: { header: 'none' },
    }) as unknown as GthConfig;

  /** The tool names actually wired into the approval interrupt, or null when none was installed. */
  function wiredInterruptNames(): string[] | null {
    if (hitlMock.mock.calls.length === 0) return null;
    const options = hitlMock.mock.calls.at(-1)![0] as { interruptOn: Record<string, unknown> };
    return Object.keys(options.interruptOn).sort();
  }

  const initAt = async (rung: string, command: 'code' | 'chat' | 'api' = 'code'): Promise<void> => {
    const agent = new GthLangChainAgent(statusUpdate, resolvers as never);
    await agent.init(command, { ...baseConfig(), approvals: rung } as unknown as GthConfig);
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    createAgentMock.mockReturnValue({ invoke: vi.fn(), stream: vi.fn() });
    statusUpdate = vi.fn();
    ({ GthLangChainAgent } = await import('#src/core/GthLangChainAgent.js'));
  });

  /**
   * The tool names the model was handed with a §4.5 approval sentence appended — ANY rung's
   * sentence, read from the exported table rather than from a copy of the wording here, since the
   * four rungs word it differently and a hard-coded phrase would silently match nothing.
   */
  function suffixedNames(): string[] {
    const params = createAgentMock.mock.calls.at(-1)![0] as {
      tools: { name: string; description: string }[];
    };
    const suffixes = Object.values(RUNG_TOOL_DESCRIPTION_SUFFIXES).filter(
      (s): s is string => s !== null
    );
    return params.tools
      .filter((t) => suffixes.some((suffix) => t.description.endsWith(suffix)))
      .map((t) => t.name)
      .sort();
  }

  /**
   * The whole interrupt set, written out by hand. Every write built-in, the shell, MCP (whatever its
   * `readOnlyHint` claims), the custom tool and the internal bookkeeping tool — everything the
   * STRICTEST rung could gate, since that is the union any rung could need.
   */
  const EVERY_GATEABLE_TOOL = [
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
  ];

  it('wires every tool any rung could gate at manual', async () => {
    await initAt('manual');

    expect(wiredInterruptNames()).toEqual(EVERY_GATEABLE_TOOL);
  });

  it('leaves the read built-ins out of the interrupt at every rung', async () => {
    // No rung gates a built-in READ tool, so nothing is bought by suspending on one — and a read
    // tool that suspended would pay a graph round trip on every `read_file` at the default rung.
    for (const rung of APPROVAL_RUNGS) {
      await initAt(rung);
      expect(wiredInterruptNames()).not.toContain('read_file');
      expect(wiredInterruptNames()).not.toContain('list_directory');
    }
  });

  /**
   * **The property the mid-session switch rests on.** The graph is built once; `/approvals manual`
   * does not rebuild it. So if this set differed by rung, a session that started on the default
   * `assisted` would still hold the `assisted` set after the switch and `write_file` would be
   * written unprompted — the defect this node exists to kill, on its ordinary route.
   */
  it('wires the SAME set at every rung, so a mid-session switch cannot be starved', async () => {
    const perRung: Record<string, string[] | null> = {};
    for (const rung of APPROVAL_RUNGS) {
      await initAt(rung);
      perRung[rung] = wiredInterruptNames();
    }

    for (const rung of ['write', 'assisted', 'auto', 'bypass'] as const) {
      expect(perRung[rung], `interrupt set at ${rung}`).toEqual(EVERY_GATEABLE_TOOL);
    }
    expect(perRung['manual']).toEqual(EVERY_GATEABLE_TOOL);
  });

  it('installs the middleware at a rated rung with no shell gate', async () => {
    // `chat` emits no dev tools, so the shell gate is off — and yet the MCP and custom tools must
    // still be reachable by a `/approvals manual` later in the session. Keying the install off
    // `gateShell` (as it once was) would leave that whole session ungated whatever the user typed.
    await initAt('assisted', 'chat');

    const wired = wiredInterruptNames();
    expect(wired).not.toBeNull();
    expect(wired).toContain('mcp__docs__search');
    expect(wired).toContain('write_file');
    expect(wired).toContain('my_custom_tool');
    // Nothing is DESCRIBED as needing approval, because at `assisted` with no shell gate nothing
    // is gated — the boundary, from the model's side.
    expect(suffixedNames()).toEqual([]);
  });

  it('installs the middleware at manual on chat, where there is no shell gate to key off', async () => {
    await initAt('manual', 'chat');

    const wired = wiredInterruptNames();
    expect(wired).not.toBeNull();
    expect(wired).toContain('mcp__docs__search');
    expect(wired).toContain('write_file');
    expect(wired).toContain('my_custom_tool');
  });

  it('wires approve/reject on every interrupted tool, not just the shell', async () => {
    await initAt('manual');

    const options = hitlMock.mock.calls.at(-1)![0] as {
      interruptOn: Record<string, unknown>;
    };
    for (const value of Object.values(options.interruptOn)) {
      expect(value).toEqual({ allowedDecisions: ['approve', 'reject'] });
    }
  });

  it('suffixes exactly the tools manual gates, and no others', async () => {
    // §4.5's non-drift property, asserted end to end on the real init. At `manual` the live gated
    // set and the interrupt set coincide, because `manual` is the strictest rung.
    await initAt('manual');

    expect(suffixedNames()).toEqual(wiredInterruptNames());
  });

  /**
   * **The descriptions follow the LIVE rung, not the interrupt.** This is where the two sets visibly
   * part company: `write_file` is wired into the interrupt at `write`, and is still described as
   * free, because the runner grants it there without asking. A description built from the interrupt
   * set would tell the model every write needs approval at `write` — false, and §4.5 rates a false
   * description worse than none.
   */
  it('does not suffix the write built-ins at write, though the interrupt holds them', async () => {
    await initAt('write');

    expect(wiredInterruptNames()).toContain('write_file');
    expect(suffixedNames()).not.toContain('write_file');
    expect(suffixedNames()).toEqual([
      'gth_checklist',
      'mcp__docs__search',
      'my_custom_tool',
      SHELL_TOOL_NAME,
    ]);
  });

  it.each(['assisted', 'auto'] as const)(
    'suffixes the shell alone at %s, though the interrupt holds everything',
    async (rung) => {
      // The scope boundary as the MODEL sees it: at a rated rung nothing but the shell is described
      // as needing approval, because nothing but the shell is gated there.
      await initAt(rung);

      expect(wiredInterruptNames()).toEqual(EVERY_GATEABLE_TOOL);
      expect(suffixedNames()).toEqual([SHELL_TOOL_NAME]);
    }
  );

  it('suffixes nothing at bypass', async () => {
    await initAt('bypass');

    expect(suffixedNames()).toEqual([]);
  });

  /**
   * [[EXT-80]] — **a surface that answers no approval is not told it will be asked, either.** The
   * AG-UI server (`api`) drives the agent itself and drains no interrupt, so it is wired with
   * nothing beyond the shell gate's own set. The §4.5 descriptions have to follow: a sentence
   * promising the user's approval, on a surface where no approval can ever be requested, is the
   * drift §4.5 rates worse than carrying no description at all — and the model has no way to find
   * out, because the call simply succeeds.
   *
   * Both halves in one assertion per rung, because either alone would pass on the wrong build:
   * an empty interrupt with suffixed descriptions is exactly the state this cell exists to catch.
   * Swept over every rung, since the live set is non-empty only at the two deterministic ones.
   */
  it.each(APPROVAL_RUNGS)(
    'neither interrupts nor announces an approval on api at %s',
    async (rung) => {
      await initAt(rung, 'api');

      expect(wiredInterruptNames()).toBeNull();
      expect(suffixedNames()).toEqual([]);
    }
  );

  it('CONTROL: the same rung on code both interrupts and announces', async () => {
    // Without this, the sweep above would pass on a build that suffixed nothing anywhere.
    await initAt('manual', 'code');

    expect(wiredInterruptNames()).toEqual(EVERY_GATEABLE_TOOL);
    expect(suffixedNames()).not.toEqual([]);
  });
});
