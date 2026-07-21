import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AIMessageChunk, HumanMessage, ToolMessage } from '@langchain/core/messages';
import type { RunnableConfig } from '@langchain/core/runnables';

/**
 * TUI-C30 wiring test — the plain-surface string path (`streamFromInput`, used by every
 * `--no-tui`/piped/single-shot run) must render the compact tool indication when a tool round
 * flows through the LangGraph message stream. The indication module itself is covered by
 * plainToolIndication.spec.ts; THIS spec proves GthAbstractAgent actually feeds the stream
 * through it (the observe() call inside the stream loop).
 */

const consoleUtilsMock = {
  displayInfo: vi.fn(),
  displayToolIndication: vi.fn(),
};
vi.mock('#src/utils/consoleUtils.js', () => consoleUtilsMock);

const systemUtilsMock = {
  waitForEscape: vi.fn(),
  stopWaitingForEscape: vi.fn(),
  getUseColour: vi.fn(() => false),
  stdout: { isTTY: false, write: vi.fn() },
  env: {},
};
vi.mock('#src/utils/systemUtils.js', () => systemUtilsMock);

const runConfig: RunnableConfig = { configurable: { thread_id: 't1' } };

describe('GthAbstractAgent plain-surface tool indication (TUI-C30)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    systemUtilsMock.getUseColour.mockReturnValue(false);
  });

  it('renders name(params) + preview via displayToolIndication when a tool round streams', async () => {
    const { GthAbstractAgent } = await import('#src/core/GthAbstractAgent.js');

    class TestAgent extends GthAbstractAgent {
      async init(): Promise<void> {
        /* graph injected directly below */
      }
    }
    const agent = new TestAgent(() => {});

    (agent as any).config = { writeBinaryOutputsToFile: false };

    (agent as any).agent = {
      async invoke() {
        throw new Error('not used');
      },
      async stream() {
        // streamMode:'messages' shape — [message, metadata] pairs.
        async function* messages() {
          yield [
            new AIMessageChunk({
              content: '',
              tool_call_chunks: [
                {
                  name: 'read_file',
                  args: '{"path":"README.md"}',
                  id: 'c1',
                  index: 0,
                  type: 'tool_call_chunk',
                },
              ],
            }),
            {},
          ];
          yield [new ToolMessage({ content: 'line-1\nline-2', tool_call_id: 'c1' }), {}];
          yield [new AIMessageChunk({ content: 'The file says…' }), {}];
        }
        return messages();
      },
    };

    const stream = await agent.stream([new HumanMessage('read it')], runConfig);
    let text = '';
    for await (const chunk of stream) text += chunk;

    expect(text).toBe('The file says…'); // the model-facing text stream is untouched
    expect(consoleUtilsMock.displayToolIndication).toHaveBeenCalledTimes(1);
    const block = consoleUtilsMock.displayToolIndication.mock.calls[0][0] as string;
    expect(block).toContain('✓ 📁 read_file(path=README.md)');
    expect(block).toContain('    line-1');
    expect(block).toContain('    line-2');
  });
});
