import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AIMessage, AIMessageChunk, HumanMessage, ToolMessage } from '@langchain/core/messages';

const consoleUtilsMock = {
  displayToolIndication: vi.fn(),
};
vi.mock('#src/utils/consoleUtils.js', () => consoleUtilsMock);

const systemUtilsMock = {
  getUseColour: vi.fn(),
  stdout: { isTTY: false } as { isTTY: boolean },
  env: {} as Record<string, string | undefined>,
};
vi.mock('#src/utils/systemUtils.js', () => systemUtilsMock);

/** One streamed read_file round: two arg-delta chunks, then the ToolMessage. */
function readFileRound(): Array<AIMessageChunk | ToolMessage> {
  return [
    new AIMessageChunk({
      content: '',
      tool_call_chunks: [
        {
          name: 'read_file',
          args: '{"path":"REA',
          id: 'call-1',
          index: 0,
          type: 'tool_call_chunk',
        },
      ],
    }),
    new AIMessageChunk({
      content: '',
      tool_call_chunks: [{ args: 'DME.md"}', index: 0, type: 'tool_call_chunk' }],
    }),
    new ToolMessage({ content: 'line-1\nline-2', tool_call_id: 'call-1' }),
  ];
}

describe('plainToolIndication (TUI-C30 — the --no-tui / piped surface)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.resetModules();
    systemUtilsMock.getUseColour.mockReturnValue(false);
    systemUtilsMock.stdout.isTTY = false;
    systemUtilsMock.env = {};
  });

  it('renders name(shortened-params) + a dim output preview when the ToolMessage lands', async () => {
    const { createPlainToolIndication } = await import('#src/core/plainToolIndication.js');
    const sink = vi.fn();
    const observer = createPlainToolIndication(sink);
    for (const chunk of readFileRound()) observer.observe(chunk);

    expect(sink).toHaveBeenCalledTimes(1);
    const text = sink.mock.calls[0][0] as string;
    expect(text).toContain('✓ 📁 read_file(path=README.md)'); // args re-assembled across deltas
    expect(text).toContain('\n    line-1'); // indented preview line
    expect(text).toContain('\n    line-2');
    expect(text.startsWith('\n')).toBe(true); // historical notice framing (cursor may be mid-line)
  });

  it('caps the preview at the canonical 10 lines with the overflow marker', async () => {
    const { createPlainToolIndication } = await import('#src/core/plainToolIndication.js');
    const sink = vi.fn();
    const observer = createPlainToolIndication(sink);
    const body = Array.from({ length: 14 }, (_, i) => `row-${String(i + 1).padStart(2, '0')}`);
    observer.observe(
      new AIMessageChunk({
        content: '',
        tool_call_chunks: [
          {
            name: 'read_file',
            args: '{"path":"big.txt"}',
            id: 'c1',
            index: 0,
            type: 'tool_call_chunk',
          },
        ],
      })
    );
    observer.observe(new ToolMessage({ content: body.join('\n'), tool_call_id: 'c1' }));

    const text = sink.mock.calls[0][0] as string;
    expect(text).toContain('row-01');
    expect(text).toContain('row-10');
    expect(text).not.toContain('row-11'); // beyond the canonical cap
    expect(text).toContain('… (+4 more lines)');
  });

  it('uses the ✗ glyph from the real ToolMessage.status error signal (TUI-C7)', async () => {
    const { createPlainToolIndication } = await import('#src/core/plainToolIndication.js');
    const sink = vi.fn();
    const observer = createPlainToolIndication(sink);
    observer.observe(
      new AIMessageChunk({
        content: '',
        tool_call_chunks: [
          { name: 'run_lint', args: '{}', id: 'c1', index: 0, type: 'tool_call_chunk' },
        ],
      })
    );
    observer.observe(
      new ToolMessage({ content: 'lint failed', tool_call_id: 'c1', status: 'error' })
    );
    const text = sink.mock.calls[0][0] as string;
    expect(text).toContain('✗');
    expect(text).not.toContain('✓');
  });

  it('is clean monochrome on a non-TTY even when useColour is on', async () => {
    systemUtilsMock.getUseColour.mockReturnValue(true);
    systemUtilsMock.stdout.isTTY = false;
    const { createPlainToolIndication } = await import('#src/core/plainToolIndication.js');
    const sink = vi.fn();
    const observer = createPlainToolIndication(sink);
    for (const chunk of readFileRound()) observer.observe(chunk);
    expect(sink.mock.calls[0][0]).not.toMatch(/\x1b\[/); // no ANSI at all
  });

  it('colours the block (dim summary, green/red diff) on a colour TTY', async () => {
    systemUtilsMock.getUseColour.mockReturnValue(true);
    systemUtilsMock.stdout.isTTY = true;
    const { createPlainToolIndication } = await import('#src/core/plainToolIndication.js');
    const sink = vi.fn();
    const observer = createPlainToolIndication(sink);
    observer.observe(
      new AIMessageChunk({
        content: '',
        tool_call_chunks: [
          {
            name: 'edit_file',
            args: JSON.stringify({ path: 'a.ts', edits: [{ oldText: 'old', newText: 'new' }] }),
            id: 'c1',
            index: 0,
            type: 'tool_call_chunk',
          },
        ],
      })
    );
    observer.observe(new ToolMessage({ content: 'diff applied', tool_call_id: 'c1' }));
    const text = sink.mock.calls[0][0] as string;
    expect(text).toContain('\x1b[2m'); // dim summary
    expect(text).toContain('\x1b[31m- old\x1b[0m'); // removed = red
    expect(text).toContain('\x1b[32m+ new\x1b[0m'); // added = green
  });

  it('shows only the status tail for a shell-shaped result (live output already streamed raw)', async () => {
    const { createPlainToolIndication } = await import('#src/core/plainToolIndication.js');
    const sink = vi.fn();
    const observer = createPlainToolIndication(sink);
    observer.observe(
      new AIMessageChunk({
        content: '',
        tool_call_chunks: [
          {
            name: 'run_shell_command',
            args: '{"command":"ls"}',
            id: 'c1',
            index: 0,
            type: 'tool_call_chunk',
          },
        ],
      })
    );
    observer.observe(
      new ToolMessage({
        content:
          "Executing 'ls'...\n\n<COMMAND_OUTPUT>\nfile-a\nfile-b\n</COMMAND_OUTPUT>\n" +
          "\n\nCommand 'ls' completed successfully",
        tool_call_id: 'c1',
      })
    );
    const text = sink.mock.calls[0][0] as string;
    expect(text).toContain('run_shell_command(command=ls)');
    expect(text).toContain("Command 'ls' completed successfully");
    expect(text).not.toContain('file-a'); // the default sink already streamed it live
  });

  it('handles two parallel calls in one round, attributing each result by id', async () => {
    const { createPlainToolIndication } = await import('#src/core/plainToolIndication.js');
    const sink = vi.fn();
    const observer = createPlainToolIndication(sink);
    observer.observe(
      new AIMessageChunk({
        content: '',
        tool_call_chunks: [
          {
            name: 'read_file',
            args: '{"path":"a.txt"}',
            id: 'c1',
            index: 0,
            type: 'tool_call_chunk',
          },
          {
            name: 'read_file',
            args: '{"path":"b.txt"}',
            id: 'c2',
            index: 1,
            type: 'tool_call_chunk',
          },
        ],
      })
    );
    observer.observe(new ToolMessage({ content: 'body-a', tool_call_id: 'c1' }));
    observer.observe(new ToolMessage({ content: 'body-b', tool_call_id: 'c2' }));
    expect(sink).toHaveBeenCalledTimes(2);
    expect(sink.mock.calls[0][0]).toContain('read_file(path=a.txt)');
    expect(sink.mock.calls[0][0]).toContain('body-a');
    expect(sink.mock.calls[1][0]).toContain('read_file(path=b.txt)');
    expect(sink.mock.calls[1][0]).toContain('body-b');
  });

  it('re-uses chunk indexes across rounds without cross-attributing (reset on ToolMessage)', async () => {
    const { createPlainToolIndication } = await import('#src/core/plainToolIndication.js');
    const sink = vi.fn();
    const observer = createPlainToolIndication(sink);
    // Round 1, index 0.
    observer.observe(
      new AIMessageChunk({
        content: '',
        tool_call_chunks: [
          {
            name: 'read_file',
            args: '{"path":"a.txt"}',
            id: 'c1',
            index: 0,
            type: 'tool_call_chunk',
          },
        ],
      })
    );
    observer.observe(new ToolMessage({ content: 'body-a', tool_call_id: 'c1' }));
    // Round 2 restarts at index 0 (the OpenAI behaviour processEventStream also resets for).
    observer.observe(
      new AIMessageChunk({
        content: '',
        tool_call_chunks: [
          { name: 'run_tests', args: '{}', id: 'c2', index: 0, type: 'tool_call_chunk' },
        ],
      })
    );
    observer.observe(new ToolMessage({ content: 'suite green', tool_call_id: 'c2' }));
    expect(sink).toHaveBeenCalledTimes(2);
    expect(sink.mock.calls[1][0]).toContain('run_tests()');
    expect(sink.mock.calls[1][0]).toContain('suite green');
  });

  it('registers complete tool_calls from a non-chunk AIMessage (resumed runs)', async () => {
    const { createPlainToolIndication } = await import('#src/core/plainToolIndication.js');
    const sink = vi.fn();
    const observer = createPlainToolIndication(sink);
    observer.observe(
      new AIMessage({
        content: '',
        tool_calls: [{ id: 'c9', name: 'read_file', args: { path: 'x.md' } }],
      })
    );
    observer.observe(new ToolMessage({ content: 'x-body', tool_call_id: 'c9' }));
    expect(sink.mock.calls[0][0]).toContain('read_file(path=x.md)');
  });

  it('still renders (name from the ToolMessage) when the call was never tracked', async () => {
    const { createPlainToolIndication } = await import('#src/core/plainToolIndication.js');
    const sink = vi.fn();
    const observer = createPlainToolIndication(sink);
    observer.observe(
      new ToolMessage({ content: 'orphan body', tool_call_id: 'nope', name: 'mystery_tool' })
    );
    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink.mock.calls[0][0]).toContain('mystery_tool()');
    expect(sink.mock.calls[0][0]).toContain('orphan body');
  });

  // fix-cycle-1 regression — redact-before-truncate on the PLAIN surface end-to-end: a >48-char
  // patternless literal secret (held in a secret-named env var, passed as a tool arg) must be
  // FULLY redacted in the rendered summary, never a truncated head of it.
  it('fully redacts an over-cap patternless env secret in the params summary', async () => {
    const secret = 'deadbeef'.repeat(8); // 64 chars, matches no provider pattern
    systemUtilsMock.env = { MY_SERVICE_TOKEN: secret };
    const { createPlainToolIndication } = await import('#src/core/plainToolIndication.js');
    const sink = vi.fn();
    const observer = createPlainToolIndication(sink);
    observer.observe(
      new AIMessageChunk({
        content: '',
        tool_call_chunks: [
          {
            name: 'gth_web_fetch',
            args: JSON.stringify({ url: 'https://x.test', token: secret }),
            id: 'c1',
            index: 0,
            type: 'tool_call_chunk',
          },
        ],
      })
    );
    observer.observe(new ToolMessage({ content: 'fetched', tool_call_id: 'c1' }));
    const text = sink.mock.calls[0][0] as string;
    expect(text).toContain('token=<redacted>');
    expect(text).not.toContain('deadbeef'); // no leaked head anywhere in the block
  });

  // TUI-C32 residual e — the fail-soft try/catch used to wrap ONLY the ToolMessage branch; the
  // AIMessage branch(es) parse tool_calls (`JSON.stringify(tc.args)` can throw on an unserialisable
  // arg, e.g. a BigInt) unguarded. A throw there would break the run's stream loop. Wrap them too.
  it('fail-soft: an unserialisable tool_call arg in the AIMessage branch does not throw', async () => {
    const { createPlainToolIndication } = await import('#src/core/plainToolIndication.js');
    const sink = vi.fn();
    const observer = createPlainToolIndication(sink);
    // JSON.stringify throws on a BigInt — the AIMessage branch must swallow it like the ToolMessage
    // branch, never propagating out of observe().
    expect(() =>
      observer.observe(
        new AIMessage({
          content: '',
          tool_calls: [{ id: 'c1', name: 'read_file', args: { n: 1n } as never }],
        })
      )
    ).not.toThrow();
    // The observer stays usable: a subsequent well-formed round still renders.
    observer.observe(
      new AIMessage({
        content: '',
        tool_calls: [{ id: 'c2', name: 'read_file', args: { path: 'ok.md' } }],
      })
    );
    observer.observe(new ToolMessage({ content: 'body-ok', tool_call_id: 'c2' }));
    expect(sink.mock.calls.at(-1)?.[0]).toContain('read_file(path=ok.md)');
  });

  it('ignores plain text chunks and human messages entirely', async () => {
    const { createPlainToolIndication } = await import('#src/core/plainToolIndication.js');
    const sink = vi.fn();
    const observer = createPlainToolIndication(sink);
    observer.observe(new AIMessageChunk({ content: 'hello ' }));
    observer.observe(new HumanMessage('hi'));
    expect(sink).not.toHaveBeenCalled();
  });
});
