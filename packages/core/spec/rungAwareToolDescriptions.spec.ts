/**
 * EXT-58 acceptance for spec §4.5 (rung-aware tool descriptions) and the granted-built-in list
 * §4.4 draws on.
 *
 * Two halves:
 *
 * 1. The pure policy (`config/tool-descriptions.ts`), matrixed over **five rungs × the built-in
 *    set** — twice, with the gated set INJECTED both times, because the suffix is a function of the
 *    set and not of any particular caller's. Once with the shell alone, which is what the rated
 *    rungs and `bypass` wire; once with a wide set, which is what the deterministic rungs wire. The
 *    second pass is what makes the rung's access-class rule observable — `manual` grants read
 *    tools only, `write` and up also grant write tools.
 *
 *    Which set each rung actually receives is `resolveGatedToolNames`' job and is pinned in
 *    `gatedToolSet.spec.ts`; here the set is a parameter, so these assertions stay honest whatever
 *    the resolver decides.
 * 2. The wiring, driven through the REAL `GthLangChainAgent.init` with `createAgent` mocked, so
 *    the assertions are about the descriptions the graph is actually handed — including that the
 *    suffix follows the RESOLVED rung, per-command override and all.
 *
 * The load-bearing negative in both halves: **a granted tool carries NO suffix.** The absence of
 * the sentence is what marks a tool free, so any assertion here that a description is byte-equal
 * to the original is testing the design, not an implementation detail.
 */
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import {
  APPROVAL_RUNGS,
  applyRungAwareToolDescriptions,
  describeGrantedBuiltInTools,
  isGrantedAtRung,
  RUNG_TOOL_DESCRIPTION_SUFFIXES,
  SHELL_TOOL_NAME,
  stripRungToolDescriptionSuffix,
  type ApprovalRung,
  type GthConfig,
} from '#src/config.js';
import type { StatusUpdateCallback } from '#src/core/types.js';

// Silence the user-facing display fns so the suite's stdout stays clean; everything else in
// consoleUtils stays real. Self-contained factory: this module is pulled in by the static
// `#src/config.js` import below, i.e. before any outer `const` in this file is initialized.
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
vi.mock('langchain', async () => {
  const actual = await vi.importActual<typeof import('langchain')>('langchain');
  return { ...actual, createAgent: createAgentMock };
});

vi.mock('#src/middleware/registry.js', () => ({ resolveMiddleware: vi.fn(async () => []) }));

vi.mock('#src/utils/llmUtils.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('#src/utils/llmUtils.js')>();
  return {
    ...actual,
    buildSystemMessages: vi.fn(() => [{ content: 'SYSTEM PROMPT' }]),
    readChatPrompt: vi.fn(() => 'chat-mode-prompt'),
    readCodePrompt: vi.fn(() => 'code-mode-prompt'),
    readExecPrompt: vi.fn(() => 'exec-mode-prompt'),
  };
});

/** The distinct sentences of §4.5's table, referenced by rung. */
const SUFFIX = RUNG_TOOL_DESCRIPTION_SUFFIXES;

/** A representative slice of the built-in set, one per class the policy distinguishes. */
const TOOL_FIXTURES = [
  { name: 'read_file', description: 'Read one file.' },
  { name: 'list_directory', description: 'List a directory.' },
  { name: 'gth_grep', description: 'Search file contents.' },
  { name: 'write_file', description: 'Write one file.' },
  { name: 'edit_file', description: 'Edit one file.' },
  { name: 'delete_file', description: 'Delete one file.' },
  { name: 'gth_web_fetch', description: 'Fetch a URL.' },
  { name: 'run_tests', description: 'Run the tests.' },
  { name: SHELL_TOOL_NAME, description: 'Run a shell command.' },
  { name: 'mcp__srv__query', description: 'Query the server.' },
] as const;

const ORIGINAL_DESCRIPTIONS = new Map(TOOL_FIXTURES.map((t) => [t.name, t.description]));

function freshTools(): { name: string; description: string }[] {
  return TOOL_FIXTURES.map((t) => ({ name: t.name, description: t.description }));
}

/** Names whose description differs from the fixture's original, mapped to the appended sentence. */
function suffixedNames(tools: { name: string; description: string }[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const tool of tools) {
    const original = ORIGINAL_DESCRIPTIONS.get(tool.name)!;
    if (tool.description === original) continue;
    expect(tool.description.startsWith(`${original} `)).toBe(true);
    out[tool.name] = tool.description.slice(original.length + 1);
  }
  return out;
}

describe('§4.5 suffix table', () => {
  it('carries the three wordings verbatim, with bypass appending nothing', () => {
    // manual and write share one sentence: at both rungs the user's approval is a certainty.
    expect(SUFFIX['manual']).toBe(
      "Calling this tool will require the user's approval. Only use it when the result cannot be " +
        'achieved with the other provided tools.'
    );
    expect(SUFFIX.write).toBe(SUFFIX['manual']);
    expect(SUFFIX['assisted']).toBe(
      "Calling this tool MAY require the user's approval if it does not look safe. Only use it " +
        'when it is impossible to achieve the result with the other provided tools.'
    );
    // `auto` has its OWN sentence, and it names the consequence that differs: [[EXT-29]]'s
    // negotiation hands a call the rater will not clear back to the model rather than to the user,
    // so the first thing that happens there is a refusal the model can answer. Its `MAY` qualifies
    // the rater's refusal rather than the user's approval, so the sentence says nothing either way
    // about whether a person can be asked — deliberately, since this is §4.5's row verbatim.
    // Sharing `assisted`'s wording would hide a real difference in the model's own tool-selection
    // input, which is what §4.5 exists to prevent.
    expect(SUFFIX['auto']).toBe(
      'Calling this tool MAY be refused by the auto-rater if it does not look safe. Only use it ' +
        'when it is impossible to achieve the result with the other provided tools.'
    );
    expect(SUFFIX['auto']).not.toBe(SUFFIX['assisted']);
    expect(SUFFIX.bypass).toBeNull();
  });

  it('covers every rung of the ladder', () => {
    expect(Object.keys(SUFFIX).sort()).toEqual([...APPROVAL_RUNGS].sort());
  });
});

describe('§4.5 registration matrix — a shell-only gated set (what the rated rungs wire)', () => {
  // At `assisted`, `auto` and `bypass` the gated set is the shell alone, so the shell is the
  // only tool that can carry a sentence. A tool the gate does not gate cannot require approval.
  const gatedTools = [SHELL_TOOL_NAME];

  it.each([
    ['manual', SUFFIX['manual']],
    ['write', SUFFIX.write],
    ['assisted', SUFFIX['assisted']],
    ['auto', SUFFIX['auto']],
  ] as const)('at %s exactly the gated shell carries the sentence', (rung, expected) => {
    const tools = freshTools();
    applyRungAwareToolDescriptions(tools, { rung: rung as ApprovalRung, gatedTools });
    expect(suffixedNames(tools)).toEqual({ [SHELL_TOOL_NAME]: expected });
  });

  it('at bypass no tool is modified at all', () => {
    const tools = freshTools();
    applyRungAwareToolDescriptions(tools, { rung: 'bypass', gatedTools });
    expect(suffixedNames(tools)).toEqual({});
    for (const tool of tools) {
      expect(tool.description).toBe(ORIGINAL_DESCRIPTIONS.get(tool.name));
    }
  });
});

describe('§4.5 registration matrix — with a wide gated set (what the deterministic rungs wire)', () => {
  // The rung's own access-class rule, made observable: with everything but the read tools gated,
  // `manual` and `write` differ in WHICH tools are granted.
  const gatedTools = [
    SHELL_TOOL_NAME,
    'read_file',
    'list_directory',
    'gth_grep',
    'write_file',
    'edit_file',
    'delete_file',
    'gth_web_fetch',
    'run_tests',
    'mcp__srv__query',
  ];

  it('at manual the read tools are granted and the write tools are not', () => {
    const tools = freshTools();
    applyRungAwareToolDescriptions(tools, { rung: 'manual', gatedTools });
    expect(suffixedNames(tools)).toEqual({
      write_file: SUFFIX['manual'],
      edit_file: SUFFIX['manual'],
      delete_file: SUFFIX['manual'],
      gth_web_fetch: SUFFIX['manual'],
      run_tests: SUFFIX['manual'],
      mcp__srv__query: SUFFIX['manual'],
      [SHELL_TOOL_NAME]: SUFFIX['manual'],
    });
  });

  it.each([
    ['write', SUFFIX.write],
    ['assisted', SUFFIX['assisted']],
    ['auto', SUFFIX['auto']],
  ] as const)('at %s the read AND write tools are granted', (rung, expected) => {
    const tools = freshTools();
    applyRungAwareToolDescriptions(tools, { rung: rung as ApprovalRung, gatedTools });
    expect(suffixedNames(tools)).toEqual({
      gth_web_fetch: expected,
      run_tests: expected,
      mcp__srv__query: expected,
      [SHELL_TOOL_NAME]: expected,
    });
  });

  it('at bypass still modifies nothing, however wide the gate is', () => {
    const tools = freshTools();
    applyRungAwareToolDescriptions(tools, { rung: 'bypass', gatedTools });
    expect(suffixedNames(tools)).toEqual({});
  });
});

describe('applyRungAwareToolDescriptions — mechanics', () => {
  it('is idempotent and re-appliable: a second pass replaces, never stacks', () => {
    const tools = freshTools();
    applyRungAwareToolDescriptions(tools, { rung: 'manual', gatedTools: [SHELL_TOOL_NAME] });
    applyRungAwareToolDescriptions(tools, { rung: 'manual', gatedTools: [SHELL_TOOL_NAME] });
    expect(suffixedNames(tools)).toEqual({ [SHELL_TOOL_NAME]: SUFFIX['manual'] });

    applyRungAwareToolDescriptions(tools, { rung: 'auto', gatedTools: [SHELL_TOOL_NAME] });
    expect(suffixedNames(tools)).toEqual({ [SHELL_TOOL_NAME]: SUFFIX['auto'] });

    // …and dropping to bypass restores the tool's own description exactly.
    applyRungAwareToolDescriptions(tools, { rung: 'bypass', gatedTools: [SHELL_TOOL_NAME] });
    expect(tools.find((t) => t.name === SHELL_TOOL_NAME)!.description).toBe('Run a shell command.');
  });

  it('leaves nameless tools (provider-native ServerTools) alone', () => {
    const tools = [{ description: 'A provider-native tool with no name.' }];
    applyRungAwareToolDescriptions(tools, { rung: 'manual', gatedTools: [SHELL_TOOL_NAME] });
    expect(tools[0].description).toBe('A provider-native tool with no name.');
  });

  it('uses the sentence as the whole description when a gated tool has none', () => {
    const tools = [{ name: SHELL_TOOL_NAME, description: '' }];
    applyRungAwareToolDescriptions(tools, { rung: 'write', gatedTools: [SHELL_TOOL_NAME] });
    expect(tools[0].description).toBe(SUFFIX.write);
  });

  it('strips every known wording, including a doubled one from an older build', () => {
    expect(stripRungToolDescriptionSuffix(`Run it. ${SUFFIX['assisted']}`)).toBe('Run it.');
    expect(stripRungToolDescriptionSuffix(`Run it. ${SUFFIX['manual']} ${SUFFIX['auto']}`)).toBe(
      'Run it.'
    );
  });
});

describe('isGrantedAtRung', () => {
  it('grants everything under bypass', () => {
    for (const name of [SHELL_TOOL_NAME, 'write_file', 'mcp__srv__query']) {
      expect(isGrantedAtRung(name, 'bypass', [SHELL_TOOL_NAME, 'write_file'])).toBe(true);
    }
  });

  it('grants any tool the gate does not gate, at every rung', () => {
    for (const rung of APPROVAL_RUNGS) {
      expect(isGrantedAtRung('write_file', rung, [SHELL_TOOL_NAME])).toBe(true);
      expect(isGrantedAtRung('mcp__srv__query', rung, [SHELL_TOOL_NAME])).toBe(true);
    }
  });

  it('never grants a gated tool with no access class outside bypass', () => {
    for (const rung of ['manual', 'write', 'assisted', 'auto'] as const) {
      expect(isGrantedAtRung(SHELL_TOOL_NAME, rung, [SHELL_TOOL_NAME])).toBe(false);
    }
  });
});

describe('§4.4 granted-built-in list', () => {
  const registered = [
    'read_file',
    'write_file',
    'gth_grep',
    SHELL_TOOL_NAME,
    'mcp__srv__query',
    'my_custom_tool',
  ];

  it('offers only registered built-ins, never the shell, never MCP or custom tools', () => {
    const granted = describeGrantedBuiltInTools(registered, 'assisted', [SHELL_TOOL_NAME]);
    expect(granted.map((t) => t.name)).toEqual(['read_file', 'write_file', 'gth_grep']);
    // Every description is locally authored text, never a tool's own (possibly hostile) blurb.
    for (const tool of granted) {
      expect(tool.description.length).toBeGreaterThan(0);
    }
  });

  /**
   * Ungated is not the same as offerable. §4.5's justification for disclosing the posture is that
   * the granted tools are "by construction, the constrained ones confined to the working folder";
   * a network fetch is not one of those. Offering it would let a refused `curl` come back as a
   * suggestion whose §7 clause promises the model it "will not interrupt the user" — a refused
   * egress turned into a free one, through the rater rather than through the gate.
   */
  it('never offers gth_web_fetch, however ungated it is', () => {
    for (const rung of APPROVAL_RUNGS) {
      const granted = describeGrantedBuiltInTools(
        ['read_file', 'gth_web_fetch', SHELL_TOOL_NAME],
        rung,
        [SHELL_TOOL_NAME]
      );
      expect(granted.map((t) => t.name)).not.toContain('gth_web_fetch');
    }
  });

  it('never offers a tool this session did not register', () => {
    const granted = describeGrantedBuiltInTools(['read_file'], 'assisted', [SHELL_TOOL_NAME]);
    expect(granted.map((t) => t.name)).toEqual(['read_file']);
  });

  it('drops a tool the rung does not grant', () => {
    // With a widened gate, `write_file` is gated and `manual` does not grant it — offering it
    // would be offering a tool that would itself need approval.
    const granted = describeGrantedBuiltInTools(registered, 'manual', [
      SHELL_TOOL_NAME,
      'write_file',
    ]);
    expect(granted.map((t) => t.name)).toEqual(['read_file', 'gth_grep']);
  });

  it('returns nothing when no tools are registered', () => {
    expect(describeGrantedBuiltInTools([], 'assisted', [SHELL_TOOL_NAME])).toEqual([]);
  });
});

describe('§4.5 wiring — the suffix follows the RESOLVED rung', () => {
  let GthLangChainAgent: typeof import('#src/core/GthLangChainAgent.js').GthLangChainAgent;
  let statusUpdate: Mock<StatusUpdateCallback>;

  /** Resolvers handing the agent a shell tool plus a granted built-in. */
  const resolvers = {
    resolveTools: async () => [
      { name: SHELL_TOOL_NAME, description: 'Run a shell command.' },
      { name: 'read_file', description: 'Read one file.' },
    ],
  };

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

  /** The tool descriptions actually handed to `createAgent`. */
  function registeredDescriptions(): Record<string, string> {
    const params = createAgentMock.mock.calls.at(-1)![0] as {
      tools: { name: string; description: string }[];
    };
    return Object.fromEntries(params.tools.map((t) => [t.name, t.description]));
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    createAgentMock.mockReturnValue({ invoke: vi.fn(), stream: vi.fn() });
    statusUpdate = vi.fn();
    ({ GthLangChainAgent } = await import('#src/core/GthLangChainAgent.js'));
  });

  it('appends the rung sentence to the gated shell and nothing to the granted read tool', async () => {
    const agent = new GthLangChainAgent(statusUpdate, resolvers as never);
    await agent.init('code', { ...baseConfig(), approvals: 'write' } as GthConfig);

    expect(registeredDescriptions()).toEqual({
      [SHELL_TOOL_NAME]: `Run a shell command. ${SUFFIX.write}`,
      read_file: 'Read one file.',
    });
  });

  it('appends nothing at all under bypass', async () => {
    const agent = new GthLangChainAgent(statusUpdate, resolvers as never);
    await agent.init('code', { ...baseConfig(), approvals: 'bypass' } as GthConfig);

    expect(registeredDescriptions()).toEqual({
      [SHELL_TOOL_NAME]: 'Run a shell command.',
      read_file: 'Read one file.',
    });
  });

  it('follows a per-command override rather than the root rung', async () => {
    // A description generated from the ROOT rung would say nothing here (root is bypass) while the
    // gate would in fact stop and ask — exactly the disagreement §4.5 forbids.
    const agent = new GthLangChainAgent(statusUpdate, resolvers as never);
    await agent.init('code', {
      ...baseConfig(),
      approvals: 'bypass',
      commands: { code: { approvals: 'manual' } },
    } as unknown as GthConfig);

    expect(registeredDescriptions()[SHELL_TOOL_NAME]).toBe(
      `Run a shell command. ${SUFFIX['manual']}`
    );
  });

  it('follows a per-command override in the permissive direction too', async () => {
    const agent = new GthLangChainAgent(statusUpdate, resolvers as never);
    await agent.init('code', {
      ...baseConfig(),
      approvals: 'manual',
      commands: { code: { approvals: 'bypass' } },
    } as unknown as GthConfig);

    expect(registeredDescriptions()[SHELL_TOOL_NAME]).toBe('Run a shell command.');
  });

  it('uses the assisted wording at the default rung', async () => {
    const agent = new GthLangChainAgent(statusUpdate, resolvers as never);
    await agent.init('code', baseConfig());

    expect(registeredDescriptions()[SHELL_TOOL_NAME]).toBe(
      `Run a shell command. ${SUFFIX['assisted']}`
    );
  });

  it('appends nothing at a rated rung when the shell tool is not gated', async () => {
    // `chat` emits no dev tools, so the shell gate is off; at a rated rung the gated set is the
    // shell alone, so nothing is gated at all and no description may claim otherwise.
    const agent = new GthLangChainAgent(statusUpdate, resolvers as never);
    await agent.init('chat', { ...baseConfig(), approvals: 'assisted' } as GthConfig);

    expect(registeredDescriptions()).toEqual({
      [SHELL_TOOL_NAME]: 'Run a shell command.',
      read_file: 'Read one file.',
    });
  });

  it('still suffixes a bound tool with no access class at manual with the shell gate off', async () => {
    // EXT-80: at a deterministic rung the gated set is derived from the BOUND toolset, not from
    // `gateShell`. A tool with no access class is gated there even on a command that wires no shell
    // gate — which is what makes `manual` true for a chat session's MCP and custom tools. The
    // granted read built-in must still carry nothing.
    const agent = new GthLangChainAgent(statusUpdate, resolvers as never);
    await agent.init('chat', { ...baseConfig(), approvals: 'manual' } as GthConfig);

    expect(registeredDescriptions()).toEqual({
      [SHELL_TOOL_NAME]: `Run a shell command. ${SUFFIX['manual']}`,
      read_file: 'Read one file.',
    });
  });

  it('records the registered tool names for the rater granted-list', async () => {
    const agent = new GthLangChainAgent(statusUpdate, resolvers as never);
    await agent.init('code', baseConfig());

    expect(agent.getRegisteredToolNames()).toEqual([SHELL_TOOL_NAME, 'read_file']);
  });
});
