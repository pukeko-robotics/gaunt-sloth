/**
 * [[OPS-158]] A round of two tool calls in one assistant message, where the human refuses the
 * gated one: **only the refused call is refused. Its allowed sibling still runs.**
 *
 * The rule, as langchain's `humanInTheLoopMiddleware` implements it: every call stays on the
 * assistant message, a rejected call is answered with a refusal `ToolMessage` in place of running,
 * and any call still without a `ToolMessage` goes on to the tool node. So after the refusal the
 * model sees one `ToolMessage` per call, the refusal for the gated call and the real result for the
 * sibling. A round with a call left unanswered is one the provider APIs reject outright.
 *
 * Driven through the REAL `GthAgentRunner` + `GthLangChainAgent` + `createAgent` graph, with a
 * scripted model and two recording tools, in the shape of `GthLeanShellApprovalGate.spec.ts`:
 * execution is the observable, so neither tool is mocked. The PTY twin of this round is
 * `packages/app/tui-e2e/approval-sibling.tui.test.ts`, which asserts what the screen says about it.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { MemorySaver } from '@langchain/langgraph';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import type { GthConfig } from '#src/config.js';
import { peekProjectDir, setProjectDir } from '#src/utils/systemUtils.js';
import type { PendingToolInterrupt, ToolApprovalDecision } from '#src/core/types.js';

// Prompt composition is stubbed so the system prompt is deterministic and nothing reads the
// on-disk gsloth config; the rest of llmUtils stays real.
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

// Keep the suite's stdout clean; the rest of consoleUtils stays real.
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

const SHELL_COMMAND = 'rm -rf build';
const REFUSAL = 'Not that one.';

/**
 * Asks for both calls in one assistant message on the first turn, and records every message list
 * it is handed, so the spec can read exactly what the model saw after the round.
 */
class ScriptedSiblingRoundModel extends BaseChatModel {
  readonly seen: BaseMessage[][] = [];
  _llmType(): string {
    return 'scripted';
  }
  bindTools(): unknown {
    return this;
  }
  async _generate(messages: BaseMessage[]) {
    this.seen.push([...messages]);
    const last = messages[messages.length - 1];
    const message = ToolMessage.isInstance(last)
      ? new AIMessage('final answer')
      : new AIMessage({
          content: '',
          tool_calls: [
            { name: 'list_directory', args: { path: '.' }, id: 'call-read' },
            { name: 'run_shell_command', args: { command: SHELL_COMMAND }, id: 'call-shell' },
          ],
        });
    const text = typeof message.content === 'string' ? message.content : '';
    return { generations: [{ message, text }] };
  }
}

describe('[[OPS-158]] refusing one call in a round leaves its allowed sibling running', () => {
  let GthAgentRunner: typeof import('#src/core/GthAgentRunner.js').GthAgentRunner;
  /** What each tool ACTUALLY ran. */
  let listed: string[];
  let executed: string[];

  // EXT-71 — clamp the grant-store anchor so a gated call never touches the real project's files.
  const projectDir = mkdtempSync(join(tmpdir(), 'gth-sibling-round-spec-'));
  let priorProjectDir: string | undefined;

  beforeEach(async () => {
    vi.resetAllMocks();
    priorProjectDir = peekProjectDir();
    setProjectDir(projectDir);
    listed = [];
    executed = [];
    ({ GthAgentRunner } = await import('#src/core/GthAgentRunner.js'));
  });

  afterEach(() => {
    setProjectDir(priorProjectDir);
  });

  afterAll(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  const tools = () => [
    tool(
      async ({ path }: { path: string }) => {
        listed.push(path);
        return `listing of ${path}: sibling-result-marker`;
      },
      {
        name: 'list_directory',
        description: 'List a directory.',
        schema: z.object({ path: z.string() }),
      }
    ),
    tool(
      async ({ command }: { command: string }) => {
        executed.push(command);
        return `ran: ${command}`;
      },
      {
        name: 'run_shell_command',
        description: 'Run a shell command.',
        schema: z.object({ command: z.string() }),
      }
    ),
  ];

  it('answers the refused call with a refusal, runs the sibling, and gives every call a ToolMessage', async () => {
    const runner = new GthAgentRunner(vi.fn(), {
      resolveTools: vi.fn().mockResolvedValue(tools()),
      resolveMiddleware: async (m: unknown[] | undefined) => m ?? [],
    });
    const model = new ScriptedSiblingRoundModel({});
    const config = {
      streamOutput: true,
      contentSource: 'file',
      requirementSource: 'file',
      filesystem: 'none',
      useColour: false,
      writeOutputToFile: false,
      writeBinaryOutputsToFile: false,
      streamSessionInferenceLog: false,
      canInterruptInferenceWithEsc: false,
      includeCurrentDateAfterGuidelines: true,
      llm: model,
      // `write` gates the shell and always asks the human, while the read is allowed unprompted.
      approvals: 'write',
    } as unknown as GthConfig;
    await runner.init('code', config, new MemorySaver());

    const asked: string[] = [];
    runner.setToolApprovalCallback(
      vi.fn(async (pending: PendingToolInterrupt): Promise<ToolApprovalDecision> => {
        asked.push(pending.name);
        return { type: 'reject', message: REFUSAL };
      })
    );

    for await (const _event of runner.processMessagesWithEvents([new HumanMessage('go')])) {
      // drain the turn
    }

    // The human was asked about the gated call alone, and refused it.
    expect(asked).toEqual(['run_shell_command']);
    // The refused call never ran. The sibling did.
    expect(executed).toEqual([]);
    expect(listed).toEqual(['.']);

    // The model was called again after the round, and that call carries the whole round.
    expect(model.seen).toHaveLength(2);
    const after = model.seen[1];
    const round = after.find(
      (message): message is AIMessage =>
        AIMessage.isInstance(message) && (message.tool_calls?.length ?? 0) > 0
    );
    expect(round?.tool_calls?.map((call) => call.id)).toEqual(['call-read', 'call-shell']);

    const toolMessages = after.filter((message): message is ToolMessage =>
      ToolMessage.isInstance(message)
    );
    const byId = new Map(toolMessages.map((message) => [message.tool_call_id, message]));
    // Every call on the assistant message has exactly one ToolMessage.
    expect(toolMessages.map((message) => message.tool_call_id).sort()).toEqual([
      'call-read',
      'call-shell',
    ]);
    expect(String(byId.get('call-shell')?.content)).toBe(REFUSAL);
    expect(String(byId.get('call-read')?.content)).toContain('sibling-result-marker');
  });
});
