import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GthConfig } from '#src/config.js';
import { buildPermissions } from '#src/core/deepAgentPermissions.js';

// Capture createDeepAgent params; stub FilesystemBackend as a constructible marker.
const createDeepAgentMock = vi.fn();
class FilesystemBackendStub {
  options: unknown;
  constructor(options: unknown) {
    this.options = options;
  }
}
vi.mock('deepagents', () => ({
  createDeepAgent: createDeepAgentMock,
  FilesystemBackend: FilesystemBackendStub,
}));

// Stub the prompt readers (they otherwise hit the gsloth config path on disk) so the composed
// systemPrompt is deterministic. buildSystemMessages returns a single SystemMessage-shaped object.
const buildSystemMessagesMock = vi.fn();
const readChatPromptMock = vi.fn();
const readCodePromptMock = vi.fn();
const readExecPromptMock = vi.fn();
vi.mock('@gaunt-sloth/core/utils/llmUtils.js', () => ({
  buildSystemMessages: buildSystemMessagesMock,
  readChatPrompt: readChatPromptMock,
  readCodePrompt: readCodePromptMock,
  readExecPrompt: readExecPromptMock,
  formatToolCalls: vi.fn(() => ''),
}));

function fakeTool(name: string, metadata?: Record<string, unknown>): any {
  const invoke = vi.fn();
  return { name, description: name, metadata, invoke, call: invoke, schema: {} };
}

function makeConfig(over: Partial<GthConfig> = {}): GthConfig {
  return {
    llm: { bindTools: () => ({}) } as any,
    filesystem: 'all',
    streamOutput: true,
    ...over,
  } as GthConfig;
}

describe('GthDeepAgent', () => {
  const statusUpdate = vi.fn();

  beforeEach(() => {
    vi.resetAllMocks();
    createDeepAgentMock.mockReturnValue({ invoke: vi.fn(), stream: vi.fn() });
    readChatPromptMock.mockReturnValue('chat-mode-prompt');
    readCodePromptMock.mockReturnValue('code-mode-prompt');
    readExecPromptMock.mockReturnValue('exec-mode-prompt');
    buildSystemMessagesMock.mockReturnValue([{ content: 'SYSTEM PROMPT' }]);
  });

  it('builds a deep agent with model, FilesystemBackend, permissions and checkpointer', async () => {
    const { GthDeepAgent } = await import('#src/core/GthDeepAgent.js');
    const resolvers = {
      resolveTools: vi.fn().mockResolvedValue([fakeTool('foo')]),
      resolveMiddleware: vi.fn().mockResolvedValue([]),
    };
    const config = makeConfig({ filesystem: 'none' });
    const agent = new GthDeepAgent(statusUpdate, resolvers);

    const checkpointer = { id: 'cp' } as any;

    await agent.init(undefined, config, checkpointer);

    expect(createDeepAgentMock).toHaveBeenCalledTimes(1);
    const params = createDeepAgentMock.mock.calls[0][0];
    expect(params.model).toBe(config.llm);
    expect(params.checkpointer).toBe(checkpointer);
    expect(params.backend).toBeInstanceOf(FilesystemBackendStub);
    // EXT-13: the backend always runs in real-path mode now (virtualMode off); containment is
    // enforced by the permission globs anchored at the real cwd, not the virtual-root chroot.
    expect((params.backend as FilesystemBackendStub).options).toMatchObject({ virtualMode: false });
    expect(params.permissions).toEqual(buildPermissions({ filesystem: 'none' }));
    expect(params.tools.map((t: { name: string }) => t.name)).toEqual(['foo']);
  });

  it('with allowDirs (--allow-dir) drops virtualMode and uses the widened permission allow-list', async () => {
    const { GthDeepAgent } = await import('#src/core/GthDeepAgent.js');
    const agent = new GthDeepAgent(statusUpdate, { resolveTools: vi.fn().mockResolvedValue([]) });
    const config = makeConfig({ filesystem: 'all', allowDirs: ['/tmp/out'] });

    await agent.init('exec', config);

    const params = createDeepAgentMock.mock.calls[0][0];
    // Sandbox widened: backend runs without virtualMode so real absolute paths resolve.
    expect((params.backend as FilesystemBackendStub).options).toMatchObject({ virtualMode: false });
    // Permissions use the widened cwd + allowDirs allow-list rather than plain filesystem mode.
    expect(params.permissions).toEqual(
      buildPermissions({ filesystem: 'all', allowDirs: ['/tmp/out'] })
    );
    // And it announces the guardrail removal loudly.
    expect(statusUpdate).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('widened beyond cwd')
    );
  });

  it('without allowDirs runs in real-path mode too (EXT-13: default cwd sandbox via globs)', async () => {
    const { GthDeepAgent } = await import('#src/core/GthDeepAgent.js');
    const agent = new GthDeepAgent(statusUpdate, { resolveTools: vi.fn().mockResolvedValue([]) });

    await agent.init('exec', makeConfig({ filesystem: 'all' }));

    const params = createDeepAgentMock.mock.calls[0][0];
    // EXT-13: the default sandbox no longer relies on virtualMode — the backend uses real
    // absolute paths and the cwd allow/deny globs do the containment.
    expect((params.backend as FilesystemBackendStub).options).toMatchObject({ virtualMode: false });
  });

  it('passes the composed gsloth system prompt to createDeepAgent (chat prompt by default)', async () => {
    const { GthDeepAgent } = await import('#src/core/GthDeepAgent.js');
    const agent = new GthDeepAgent(statusUpdate, { resolveTools: vi.fn().mockResolvedValue([]) });
    const config = makeConfig();

    await agent.init('chat', config);

    // 'code' uses the code-mode prompt; everything else (chat/api/…) uses the chat-mode prompt.
    expect(readChatPromptMock).toHaveBeenCalledWith(config);
    expect(readCodePromptMock).not.toHaveBeenCalled();
    expect(buildSystemMessagesMock).toHaveBeenCalledWith(config, 'chat-mode-prompt');
    expect(createDeepAgentMock.mock.calls[0][0].systemPrompt).toBe('SYSTEM PROMPT');
  });

  it('uses the code-mode prompt for the code command and appends the EXT-13 cwd note', async () => {
    const { GthDeepAgent } = await import('#src/core/GthDeepAgent.js');
    const agent = new GthDeepAgent(statusUpdate, { resolveTools: vi.fn().mockResolvedValue([]) });
    const config = makeConfig();

    await agent.init('code', config);

    expect(readCodePromptMock).toHaveBeenCalledWith(config);
    expect(buildSystemMessagesMock).toHaveBeenCalledWith(config, 'code-mode-prompt');
    // EXT-13 (part b): code mode appends the real cwd + path-model note so the model knows where
    // it is (the fs tools + run_shell_command share one real-absolute-path namespace).
    const prompt = createDeepAgentMock.mock.calls[0][0].systemPrompt as string;
    expect(prompt.startsWith('SYSTEM PROMPT')).toBe(true);
    expect(prompt).toContain('Working directory:');
    expect(prompt).toContain('real absolute filesystem paths');
  });

  it('does NOT append the cwd note for non-code commands (chat keeps the bare prompt)', async () => {
    const { GthDeepAgent } = await import('#src/core/GthDeepAgent.js');
    const agent = new GthDeepAgent(statusUpdate, { resolveTools: vi.fn().mockResolvedValue([]) });

    await agent.init('chat', makeConfig());

    expect(createDeepAgentMock.mock.calls[0][0].systemPrompt).toBe('SYSTEM PROMPT');
  });

  it('leaves systemPrompt undefined when no prompt content is composed (non-code command)', async () => {
    buildSystemMessagesMock.mockReturnValue([]);
    const { GthDeepAgent } = await import('#src/core/GthDeepAgent.js');
    const agent = new GthDeepAgent(statusUpdate, { resolveTools: vi.fn().mockResolvedValue([]) });

    await agent.init('chat', makeConfig());

    expect(createDeepAgentMock.mock.calls[0][0].systemPrompt).toBeUndefined();
  });

  it('in code mode still emits the cwd note even when no other prompt content is composed', async () => {
    buildSystemMessagesMock.mockReturnValue([]);
    const { GthDeepAgent } = await import('#src/core/GthDeepAgent.js');
    const agent = new GthDeepAgent(statusUpdate, { resolveTools: vi.fn().mockResolvedValue([]) });

    await agent.init('code', makeConfig());

    // EXT-13: the cwd / path-model note is essential for code mode, so it is injected even with
    // an otherwise-empty composed prompt (no leading blank lines).
    const prompt = createDeepAgentMock.mock.calls[0][0].systemPrompt as string;
    expect(prompt).toContain('Working directory:');
    expect(prompt.startsWith('Working directory:')).toBe(true);
  });

  it('drops resolved tools that collide with deepagents filesystem tool names', async () => {
    const { GthDeepAgent } = await import('#src/core/GthDeepAgent.js');
    const resolvers = {
      resolveTools: vi.fn().mockResolvedValue([fakeTool('read_file'), fakeTool('keep')]),
    };
    const agent = new GthDeepAgent(statusUpdate, resolvers);

    await agent.init(undefined, makeConfig());

    const params = createDeepAgentMock.mock.calls[0][0];
    expect(params.tools.map((t: { name: string }) => t.name)).toEqual(['keep']);
    expect(statusUpdate).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('collide with deepagents built-in filesystem tools: read_file')
    );
  });

  it('resolves tools with filesystem disabled so gsloth fs toolkit is not loaded', async () => {
    const { GthDeepAgent } = await import('#src/core/GthDeepAgent.js');
    const resolveTools = vi.fn().mockResolvedValue([]);
    const agent = new GthDeepAgent(statusUpdate, { resolveTools });

    await agent.init(undefined, makeConfig({ filesystem: 'all' }));

    // deepagents owns the filesystem; tool resolution must see filesystem:'none' so the
    // gsloth toolkit's permission-bypassing fs tools are never loaded. Permissions still
    // reflect the real 'all' mode.
    expect(resolveTools).toHaveBeenCalledWith(
      expect.objectContaining({ filesystem: 'none' }),
      undefined
    );
  });

  it('drops a configured summarization middleware (deepagents provides it)', async () => {
    const { GthDeepAgent } = await import('#src/core/GthDeepAgent.js');
    const resolvers = {
      resolveTools: vi.fn().mockResolvedValue([]),
      resolveMiddleware: vi
        .fn()
        .mockResolvedValue([{ name: 'SummarizationMiddleware' }, { name: 'keep-mw' }]),
    };
    const agent = new GthDeepAgent(statusUpdate, resolvers);

    await agent.init(undefined, makeConfig());

    const names = createDeepAgentMock.mock.calls[0][0].middleware.map(
      (m: { name: string }) => m.name
    );
    expect(names).not.toContain('SummarizationMiddleware');
    expect(names).toContain('keep-mw');
  });

  it('maps .aiignore + filesystem mode onto permissions', async () => {
    const { GthDeepAgent } = await import('#src/core/GthDeepAgent.js');
    const config = makeConfig({
      filesystem: ['src'],
      aiignore: { enabled: true, patterns: ['*.env'] },
    });
    const agent = new GthDeepAgent(statusUpdate, { resolveTools: vi.fn().mockResolvedValue([]) });

    await agent.init(undefined, config);

    const params = createDeepAgentMock.mock.calls[0][0];
    expect(params.permissions).toEqual(
      buildPermissions({ filesystem: ['src'], aiignore: { enabled: true, patterns: ['*.env'] } })
    );
    // .aiignore deny rule comes first (wins over the src allow rule).
    expect(params.permissions[0].mode).toBe('deny');
  });

  it('orders middleware: fs-denial-softening (outermost), resolved, then status', async () => {
    const { GthDeepAgent } = await import('#src/core/GthDeepAgent.js');
    const resolvers = {
      resolveTools: vi.fn().mockResolvedValue([]),
      resolveMiddleware: vi.fn().mockResolvedValue([{ name: 'custom-mw' }]),
    };
    const agent = new GthDeepAgent(statusUpdate, resolvers);

    await agent.init(undefined, makeConfig());

    const params = createDeepAgentMock.mock.calls[0][0];
    expect(params.middleware.map((m: { name: string }) => m.name)).toEqual([
      'GthDeepFsDenialSoftening',
      'GthDeepShellExitSoftening',
      'custom-mw',
      'GthMiddlewareToolCallStatusUpdate',
      'GthMiddlewareDebugCapture',
    ]);
  });

  it('debug-capture middleware is a transparent pass-through when no sink is attached', async () => {
    const { GthDeepAgent } = await import('#src/core/GthDeepAgent.js');
    const agent = new GthDeepAgent(statusUpdate, { resolveTools: vi.fn().mockResolvedValue([]) });
    await agent.init(undefined, makeConfig());
    // No debugCapture set → the normal path.

    const debugMw = createDeepAgentMock.mock.calls[0][0].middleware.find(
      (m: { name: string }) => m.name === 'GthMiddlewareDebugCapture'
    );
    const request = { messages: [{ content: 'hi' }] };
    const response = { content: 'yo' };
    const handler = vi.fn().mockResolvedValue(response);

    const result = await debugMw.wrapModelCall(request, handler);

    expect(handler).toHaveBeenCalledWith(request);
    expect(result).toBe(response);
  });

  it('debug-capture middleware reports request history and the resolved response to the sink', async () => {
    const { GthDeepAgent } = await import('#src/core/GthDeepAgent.js');
    const agent = new GthDeepAgent(statusUpdate, { resolveTools: vi.fn().mockResolvedValue([]) });
    await agent.init(undefined, makeConfig());

    const onRequest = vi.fn();
    const onResponse = vi.fn();
    agent.debugCapture = { onRequest, onResponse };

    const debugMw = createDeepAgentMock.mock.calls[0][0].middleware.find(
      (m: { name: string }) => m.name === 'GthMiddlewareDebugCapture'
    );
    const messages = [{ content: 'system' }, { content: 'user turn' }];
    const response = { content: 'assistant reply' };
    const handler = vi.fn().mockResolvedValue(response);

    const result = await debugMw.wrapModelCall({ messages }, handler);

    // Sink saw the real request messages (at call time) and the resolved response. The second
    // onRequest arg is the request extras (tools/system/params); undefined here since this
    // minimal request carries none.
    expect(onRequest).toHaveBeenCalledWith(messages, undefined);
    expect(onResponse).toHaveBeenCalledWith(response);
    // Order: request captured before the handler runs, response after.
    expect(onRequest).toHaveBeenCalledBefore(onResponse);
    // The middleware is transparent: the handler's response flows through unchanged.
    expect(result).toBe(response);
  });

  it('debug-capture sink errors never break the run', async () => {
    const { GthDeepAgent } = await import('#src/core/GthDeepAgent.js');
    const agent = new GthDeepAgent(statusUpdate, { resolveTools: vi.fn().mockResolvedValue([]) });
    await agent.init(undefined, makeConfig());

    agent.debugCapture = {
      onRequest: () => {
        throw new Error('sink boom');
      },
      onResponse: () => {
        throw new Error('sink boom 2');
      },
    };

    const debugMw = createDeepAgentMock.mock.calls[0][0].middleware.find(
      (m: { name: string }) => m.name === 'GthMiddlewareDebugCapture'
    );
    const response = { content: 'ok' };
    const handler = vi.fn().mockResolvedValue(response);

    await expect(debugMw.wrapModelCall({ messages: [] }, handler)).resolves.toBe(response);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('fs-denial-softening converts a permission throw into an error ToolMessage', async () => {
    const { GthDeepAgent } = await import('#src/core/GthDeepAgent.js');
    const agent = new GthDeepAgent(statusUpdate, { resolveTools: vi.fn().mockResolvedValue([]) });
    await agent.init(undefined, makeConfig());

    const softening = createDeepAgentMock.mock.calls[0][0].middleware.find(
      (m: { name: string }) => m.name === 'GthDeepFsDenialSoftening'
    );
    const handler = vi
      .fn()
      .mockRejectedValue(new Error('permission denied for read on /secret.env'));

    const result = await softening.wrapToolCall({ toolCall: { id: 'tc1' } }, handler);
    expect(String(result.content)).toContain('permission denied for read on /secret.env');
    expect(result.tool_call_id).toBe('tc1');
    expect(result.status).toBe('error');
  });

  // EXT-24: deepagents' validatePath (permissions/enforce.ts) THROWS on a malformed path the
  // model supplied — a relative path, a `..`/`~` segment, or an empty string — and this throw runs
  // BEFORE the permission check. Left unsoftened it escaped both softeners and aborted the whole
  // run; on the AG-UI transport the run then ended with RUN_ERROR (a terminal event) and never
  // reached RUN_FINISHED, hanging a consumer that waits for it. Each of these must now soften to a
  // recoverable error ToolMessage (same shape as the permission-denial case) so the model can
  // retry and the run finishes normally.
  it.each([
    ['path must be absolute: "."', 'ls'],
    ['path must not contain "..": "/a/../b"', 'read_file'],
    ['path must not contain "~": "~/secrets"', 'write_file'],
    ['path must be a non-empty string', 'glob'],
  ])(
    'fs-denial-softening softens the validatePath throw %j into an error ToolMessage',
    async (message) => {
      const { GthDeepAgent } = await import('#src/core/GthDeepAgent.js');
      const agent = new GthDeepAgent(statusUpdate, { resolveTools: vi.fn().mockResolvedValue([]) });
      await agent.init(undefined, makeConfig());

      const softening = createDeepAgentMock.mock.calls[0][0].middleware.find(
        (m: { name: string }) => m.name === 'GthDeepFsDenialSoftening'
      );
      const handler = vi.fn().mockRejectedValue(new Error(message));

      const result = await softening.wrapToolCall({ toolCall: { id: 'tc-path' } }, handler);
      // Softened (not rethrown): the model observes the mistake as a normal error result and the run
      // continues to RUN_FINISHED instead of aborting into RUN_ERROR.
      expect(String(result.content)).toBe(message);
      expect(result.tool_call_id).toBe('tc-path');
      expect(result.status).toBe('error');
    }
  );

  it('fs-denial-softening rethrows non-permission errors', async () => {
    const { GthDeepAgent } = await import('#src/core/GthDeepAgent.js');
    const agent = new GthDeepAgent(statusUpdate, { resolveTools: vi.fn().mockResolvedValue([]) });
    await agent.init(undefined, makeConfig());

    const softening = createDeepAgentMock.mock.calls[0][0].middleware.find(
      (m: { name: string }) => m.name === 'GthDeepFsDenialSoftening'
    );
    const handler = vi.fn().mockRejectedValue(new Error('boom'));

    await expect(softening.wrapToolCall({ toolCall: { id: 'tc1' } }, handler)).rejects.toThrow(
      'boom'
    );
  });

  it('shell-exit-softening converts a ShellCommandFailedError into an error ToolMessage, body preserved', async () => {
    const { GthDeepAgent } = await import('#src/core/GthDeepAgent.js');
    const { ShellCommandFailedError } = await import('#src/tools/GthDevToolkit.js');
    const agent = new GthDeepAgent(statusUpdate, { resolveTools: vi.fn().mockResolvedValue([]) });
    await agent.init(undefined, makeConfig());

    const softening = createDeepAgentMock.mock.calls[0][0].middleware.find(
      (m: { name: string }) => m.name === 'GthDeepShellExitSoftening'
    );
    const body =
      "Executing 'npm test'...\n\n<COMMAND_OUTPUT>\n1 failing\n</COMMAND_OUTPUT>\n" +
      "\n\nCommand 'npm test' exited with code 1";
    const handler = vi.fn().mockRejectedValue(
      new ShellCommandFailedError({
        output: body,
        exitCode: 1,
        command: 'npm test',
        toolName: 'run_tests',
      })
    );

    const result = await softening.wrapToolCall({ toolCall: { id: 'tc-shell' } }, handler);
    // Full stdout/stderr body preserved verbatim — the model's observation is unchanged...
    expect(String(result.content)).toBe(body);
    expect(result.tool_call_id).toBe('tc-shell');
    // ...except the status flips to 'error' (→ isError → ✗ glyph).
    expect(result.status).toBe('error');
  });

  it('shell-exit-softening rethrows a non-shell error (e.g. a permission throw) for the sibling to handle', async () => {
    const { GthDeepAgent } = await import('#src/core/GthDeepAgent.js');
    const agent = new GthDeepAgent(statusUpdate, { resolveTools: vi.fn().mockResolvedValue([]) });
    await agent.init(undefined, makeConfig());

    const softening = createDeepAgentMock.mock.calls[0][0].middleware.find(
      (m: { name: string }) => m.name === 'GthDeepShellExitSoftening'
    );
    // A plain Error (not a ShellCommandFailedError) must pass straight through untouched so the
    // disjoint fsDenialSoftening sibling can still see permission throws.
    const handler = vi
      .fn()
      .mockRejectedValue(new Error('permission denied for read on /secret.env'));

    await expect(softening.wrapToolCall({ toolCall: { id: 'tc1' } }, handler)).rejects.toThrow(
      'permission denied for read on /secret.env'
    );
  });

  it('skips tool resolution entirely when allowedTools is an empty allow-list', async () => {
    const { GthDeepAgent } = await import('#src/core/GthDeepAgent.js');
    const resolveTools = vi.fn();
    const agent = new GthDeepAgent(statusUpdate, { resolveTools });

    await agent.init(undefined, makeConfig({ allowedTools: [] }));

    expect(resolveTools).not.toHaveBeenCalled();
    expect(createDeepAgentMock.mock.calls[0][0].tools).toEqual([]);
  });

  it('does not set interruptOn for a non-code command with no shell config (e.g. chat)', async () => {
    // EXT-12: the absent-config shell default is `code`-only, so `chat` (which carries no devTools
    // at all) still gets no shell tool and therefore no interrupt wiring.
    const { GthDeepAgent } = await import('#src/core/GthDeepAgent.js');
    const agent = new GthDeepAgent(statusUpdate, { resolveTools: vi.fn().mockResolvedValue([]) });

    await agent.init('chat', makeConfig());

    expect(createDeepAgentMock.mock.calls[0][0].interruptOn).toBeUndefined();
  });

  it('EXT-12: sets gated interruptOn for code with NO shell config (shell ON by default)', async () => {
    const { GthDeepAgent } = await import('#src/core/GthDeepAgent.js');
    const agent = new GthDeepAgent(statusUpdate, { resolveTools: vi.fn().mockResolvedValue([]) });

    await agent.init('code', makeConfig());

    // Absent devTools.shell in `code` mode now resolves to enabled — and still GATED (interruptOn
    // set), never yolo-by-default.
    expect(createDeepAgentMock.mock.calls[0][0].interruptOn).toEqual({
      run_shell_command: { allowedDecisions: ['approve', 'reject'] },
    });
  });

  it('EXT-12: explicit shell:false fully disables the tool in code mode (escape hatch)', async () => {
    const { GthDeepAgent } = await import('#src/core/GthDeepAgent.js');
    const agent = new GthDeepAgent(statusUpdate, { resolveTools: vi.fn().mockResolvedValue([]) });
    const config = makeConfig({
      commands: { code: { devTools: { shell: false } } } as any,
    });

    await agent.init('code', config);

    expect(createDeepAgentMock.mock.calls[0][0].interruptOn).toBeUndefined();
  });

  it('sets interruptOn for run_shell_command when shell is enabled and yolo is off', async () => {
    const { GthDeepAgent } = await import('#src/core/GthDeepAgent.js');
    const agent = new GthDeepAgent(statusUpdate, { resolveTools: vi.fn().mockResolvedValue([]) });
    const config = makeConfig({
      commands: { code: { devTools: { shell: true } } } as any,
    });

    await agent.init('code', config);

    expect(createDeepAgentMock.mock.calls[0][0].interruptOn).toEqual({
      run_shell_command: { allowedDecisions: ['approve', 'reject'] },
    });
  });

  it('omits interruptOn under yolo (shell enabled, shellYolo true) so the tool runs unconfirmed', async () => {
    const { GthDeepAgent } = await import('#src/core/GthDeepAgent.js');
    const agent = new GthDeepAgent(statusUpdate, { resolveTools: vi.fn().mockResolvedValue([]) });
    const config = makeConfig({
      commands: { code: { devTools: { shell: true, shellYolo: true } } } as any,
    });

    await agent.init('code', config);

    expect(createDeepAgentMock.mock.calls[0][0].interruptOn).toBeUndefined();
    // And it warns loudly about the bypass.
    expect(statusUpdate).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('YOLO mode')
    );
  });

  it('reads the exec command devTools for the interrupt wiring', async () => {
    const { GthDeepAgent } = await import('#src/core/GthDeepAgent.js');
    const agent = new GthDeepAgent(statusUpdate, { resolveTools: vi.fn().mockResolvedValue([]) });
    const config = makeConfig({
      commands: { exec: { devTools: { shell: true } } } as any,
    });

    await agent.init('exec', config);

    expect(createDeepAgentMock.mock.calls[0][0].interruptOn).toEqual({
      run_shell_command: { allowedDecisions: ['approve', 'reject'] },
    });
  });

  it('stubs client config tools (clones, swapping the body for interrupt)', async () => {
    const { GthDeepAgent } = await import('#src/core/GthDeepAgent.js');
    const clientTool = fakeTool('client_tool', { client: true });
    const agent = new GthDeepAgent(statusUpdate, { resolveTools: vi.fn().mockResolvedValue([]) });

    await agent.init(undefined, makeConfig({ tools: [clientTool] }));

    const passed = createDeepAgentMock.mock.calls[0][0].tools;
    expect(passed).toHaveLength(1);
    expect(passed[0].name).toBe('client_tool');
    // extractAndFlattenTools clones client tools and replaces invoke/call with a stub.
    expect(passed[0]).not.toBe(clientTool);
    expect(passed[0].invoke).not.toBe(clientTool.invoke);
  });
});

describe('appendCwdNote (EXT-13 part b)', () => {
  it('appends the real cwd + path-model note to an existing prompt', async () => {
    const { appendCwdNote } = await import('#src/core/GthDeepAgent.js');
    const out = appendCwdNote('BASE PROMPT', '/home/user/proj');
    expect(out.startsWith('BASE PROMPT\n\n')).toBe(true);
    expect(out).toContain('Working directory: /home/user/proj');
    expect(out).toContain('there is no virtual root');
    expect(out).toContain('run_shell_command');
  });

  it('returns just the note (no leading blank lines) when there is no base prompt', async () => {
    const { appendCwdNote } = await import('#src/core/GthDeepAgent.js');
    const out = appendCwdNote(undefined, '/srv/app');
    expect(out.startsWith('Working directory: /srv/app')).toBe(true);
  });
});
