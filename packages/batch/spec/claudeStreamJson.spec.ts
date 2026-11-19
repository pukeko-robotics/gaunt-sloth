import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { decodeClaudeStreamJson } from '#src/transcripts/claudeStreamJson.js';
import {
  builtInTranscriptDecoderNames,
  isTranscriptDecoderModulePath,
  resolveTranscriptDecoder,
} from '#src/transcripts/registry.js';
import { splitCommandLine } from '#src/commandArgv.js';

// BATCH-57 — the `claude-stream-json` decoder against a REAL captured Claude Code 2.1.327
// transcript (sanitised: local paths to /workspace, ids faked, the init line reduced). Two parallel
// Reads (one of a missing file, so one errored result), a Bash call, a thinking block, a final text
// and the result line.
const CAPTURE = readFileSync(
  fileURLToPath(new URL('./fixtures/claude-stream-json/capture.jsonl', import.meta.url)),
  'utf8'
);
const lines = (): Record<string, unknown>[] =>
  CAPTURE.trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line));
const join = (objects: unknown[]): string => objects.map((o) => JSON.stringify(o)).join('\n');

describe('decodeClaudeStreamJson — the captured transcript', () => {
  const decoded = decodeClaudeStreamJson(CAPTURE);

  it("takes the answer from the result line's result", () => {
    expect(decoded.answer).toBe(
      '`present.txt` contains the single line "hello from the fixture"; `missing.txt` doesn\'t ' +
        'exist, and `ls` shows `present.txt` is the only file in the directory.'
    );
  });

  it('records every call in request order with its id and JSON arguments', () => {
    expect(decoded.toolCalls).toEqual([
      {
        name: 'Read',
        id: 'toolu_01EYU97VVHhPAj5syhGKt11e',
        args: '{"file_path":"/workspace/missing.txt"}',
      },
      {
        name: 'Read',
        id: 'toolu_01RHaSDTtNEWKTumPnPzrCpV',
        args: '{"file_path":"/workspace/present.txt"}',
      },
      {
        name: 'Bash',
        id: 'toolu_018fHeu3bqBwj121qiQPRjci',
        args: '{"command":"ls","description":"List files in current directory"}',
      },
    ]);
  });

  it('pairs each result with its call by tool_use_id, with the error flag and payload', () => {
    expect(decoded.toolResults).toEqual([
      {
        name: 'Read',
        isError: true,
        content: 'File does not exist. Note: your current working directory is /workspace.',
      },
      { name: 'Read', isError: false, content: '1\thello from the fixture\n2\t' },
      { name: 'Bash', isError: false, content: 'present.txt' },
    ]);
  });

  it('counts cached prompt tokens as input', () => {
    expect(decoded.tokensInput).toBe(4 + 38330 + 61124);
    expect(decoded.tokensOutput).toBe(342);
  });
});

describe('decodeClaudeStreamJson — edges', () => {
  it('names each result by its tool_use_id when parallel calls to DIFFERENT tools answer in reverse', () => {
    // The capture's parallel pair is two Reads, so a result named by position would still read
    // "Read". Here the calls differ in tool and the errored one answers last: a positional name
    // would file the error under Read and the success under Bash, and must_error would grade the
    // wrong call.
    const transcript = join([
      { type: 'system', subtype: 'init' },
      {
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 'call_bash', name: 'Bash', input: {} }] },
      },
      {
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 'call_read', name: 'Read', input: {} }] },
      },
      {
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'call_read', content: 'y' }] },
      },
      {
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'call_bash', content: 'x', is_error: true },
          ],
        },
      },
      { type: 'result', subtype: 'success', is_error: false, result: 'done' },
    ]);
    expect(decodeClaudeStreamJson(transcript).toolResults).toEqual([
      { name: 'Read', isError: false, content: 'y' },
      { name: 'Bash', isError: true, content: 'x' },
    ]);
  });

  it('pairs results that arrive in the opposite order to their calls', () => {
    const all = lines();
    const swapped = [all[0], all[1], all[2], all[4], all[3], ...all.slice(5)];
    const decoded = decodeClaudeStreamJson(join(swapped));
    expect(decoded.toolResults.map((r) => [r.name, r.isError, r.content?.slice(0, 4)])).toEqual([
      ['Read', false, '1\the'],
      ['Read', true, 'File'],
      ['Bash', false, 'pres'],
    ]);
  });

  it('JSON-stringifies a block-array payload, as core does for a ToolMessage', () => {
    const all = lines();
    const user = all[6] as { message: { content: Array<{ content: unknown }> } };
    user.message.content[0].content = [{ type: 'text', text: 'present.txt' }];
    const decoded = decodeClaudeStreamJson(join(all));
    expect(decoded.toolResults[2].content).toBe('[{"type":"text","text":"present.txt"}]');
  });

  it("includes a subagent's calls, so must_not_call cannot pass while a subagent breaks it", () => {
    const all = lines();
    const subagentCall = {
      type: 'assistant',
      parent_tool_use_id: 'toolu_018fHeu3bqBwj121qiQPRjci',
      message: {
        content: [{ type: 'tool_use', id: 'toolu_sub', name: 'Write', input: { file_path: 'x' } }],
      },
    };
    const subagentResult = {
      type: 'user',
      parent_tool_use_id: 'toolu_018fHeu3bqBwj121qiQPRjci',
      message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_sub', content: 'ok' }] },
    };
    const decoded = decodeClaudeStreamJson(
      join([...all.slice(0, 7), subagentCall, subagentResult, ...all.slice(7)])
    );
    expect(decoded.toolCalls.map((c) => c.name)).toEqual(['Read', 'Read', 'Bash', 'Write']);
    expect(decoded.toolResults.at(-1)).toEqual({ name: 'Write', isError: false, content: 'ok' });
  });

  it('records a repeated tool_use block once', () => {
    const all = lines();
    const decoded = decodeClaudeStreamJson(join([all[0], all[1], all[1], ...all.slice(2)]));
    expect(decoded.toolCalls).toHaveLength(3);
  });

  it('skips lines that are not JSON and line types it does not read', () => {
    const decoded = decodeClaudeStreamJson(
      `warning: something\n${CAPTURE}\n{"type":"stream_event","event":{}}\n`
    );
    expect(decoded.toolCalls).toHaveLength(3);
  });

  it('throws on a transcript with no result line — a cut-off run', () => {
    const all = lines();
    expect(() => decodeClaudeStreamJson(join(all.slice(0, -1)))).toThrow(/no final "result" line/);
  });

  // BATCH-62 replaced "throws on a non-success result" with the three specs below: a non-success
  // subtype is now RETURNED as the run's outcome, with the sentence the throw used to carry, and the
  // runner decides whether it is graded (see `commandEvalRunner.ts` `gradedEnding`).
  it('returns a non-success result as its outcome, with the transcript it decoded', () => {
    const all = lines();
    // A run capped after its two tool rounds: no final text, and no `result` string.
    const result = { type: 'result', subtype: 'error_max_turns', is_error: true, num_turns: 3 };
    const decoded = decodeClaudeStreamJson(join([...all.slice(0, 7), result]));
    expect(decoded.outcome).toBe('error_max_turns');
    expect(decoded.outcomeReason).toBe('Claude Code ended the run with result "error_max_turns"');
    expect(decoded.answer).toBe('');
    expect(decoded.toolCalls.map((call) => call.name)).toEqual(['Read', 'Read', 'Bash']);
    expect(decoded.toolResults.map((r) => [r.name, r.isError])).toEqual([
      ['Read', true],
      ['Read', false],
      ['Bash', false],
    ]);
  });

  it('returns any non-success subtype as it is printed, whatever is_error says', () => {
    const all = lines();
    for (const [subtype, isError] of [
      ['error_max_budget_usd', true],
      ['error_some_future_limit', false],
    ] as const) {
      const result = { ...all.at(-1), subtype, is_error: isError, result: 'stopped' };
      const decoded = decodeClaudeStreamJson(join([...all.slice(0, -1), result]));
      expect(decoded.outcome).toBe(subtype);
      expect(decoded.outcomeReason).toBe(
        `Claude Code ended the run with result "${subtype}": stopped`
      );
      expect(decoded.answer).toBe('stopped');
    }
  });

  it('reports no outcome for a finished run', () => {
    const decoded = decodeClaudeStreamJson(CAPTURE);
    expect('outcome' in decoded).toBe(false);
    expect('outcomeReason' in decoded).toBe(false);
  });

  it('throws on a result line with no subtype, which no grade_when can name', () => {
    const all = lines();
    const result = { ...all.at(-1) };
    delete (result as Record<string, unknown>).subtype;
    expect(() => decodeClaudeStreamJson(join([...all.slice(0, -1), result]))).toThrow(
      /ended the run with result "\(none\)"/
    );
  });

  // BATCH-62: still a throw, so `grade_when` can never grade it. See the decoder's module docblock.
  it('throws on is_error even when the subtype says success', () => {
    const all = lines();
    const result = { ...all.at(-1), is_error: true };
    expect(() => decodeClaudeStreamJson(join([...all.slice(0, -1), result]))).toThrow(
      /ended the run with result "success"/
    );
  });

  it('throws on a result for a call it never saw', () => {
    const all = lines();
    expect(() => decodeClaudeStreamJson(join([all[0], all[3], all.at(-1)]))).toThrow(
      /no earlier tool_use in the transcript declared/
    );
  });

  it('takes the answer from the result line even when it differs from the last assistant text', () => {
    // In the capture the two are byte-identical, so only a transcript where they differ can tell
    // which one the decoder reads.
    const all = lines();
    const result = { ...all.at(-1), result: 'the result line says this' };
    const decoded = decodeClaudeStreamJson(join([...all.slice(0, -1), result]));
    expect(decoded.answer).toBe('the result line says this');
  });

  it('falls back to the last assistant text when the result line carries none', () => {
    const all = lines();
    const result = { ...all.at(-1) };
    delete (result as Record<string, unknown>).result;
    const decoded = decodeClaudeStreamJson(join([...all.slice(0, -1), result]));
    expect(decoded.answer).toMatch(/^`present\.txt` contains/);
  });
});

describe('transcript decoder registry', () => {
  it('resolves the built-in', () => {
    expect(builtInTranscriptDecoderNames()).toEqual(['claude-stream-json']);
    expect(resolveTranscriptDecoder('claude-stream-json')).toBe(decodeClaudeStreamJson);
  });

  it('lets a custom entry overlay, and lists what exists on an unknown name', () => {
    const custom = () => ({ answer: '', toolCalls: [], toolResults: [] });
    expect(resolveTranscriptDecoder('mine', { mine: custom })).toBe(custom);
    expect(() => resolveTranscriptDecoder('codex-json')).toThrow(
      /unknown transcript decoder "codex-json". Available decoders: claude-stream-json/
    );
  });

  it('tells a module path from a name', () => {
    for (const path of [
      './d.mjs',
      '../d.js',
      '/abs/d.js',
      'C:\\d\\x.js',
      'file:///d.js',
      'd.cjs',
    ]) {
      expect(isTranscriptDecoderModulePath(path)).toBe(true);
    }
    expect(isTranscriptDecoderModulePath('claude-stream-json')).toBe(false);
  });
});

describe('splitCommandLine', () => {
  it('splits on whitespace and keeps quoted text literal', () => {
    expect(splitCommandLine('claude -p --output-format stream-json --verbose')).toEqual([
      'claude',
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
    ]);
    expect(splitCommandLine(`a "b c" 'd "e"' --x="y z"`)).toEqual(['a', 'b c', 'd "e"', '--x=y z']);
    expect(splitCommandLine('a "" b')).toEqual(['a', '', 'b']);
  });

  it('keeps a backslash, so a Windows path survives', () => {
    expect(splitCommandLine('"C:\\Program Files\\nodejs\\node.exe" C:\\x\\cli.js')).toEqual([
      'C:\\Program Files\\nodejs\\node.exe',
      'C:\\x\\cli.js',
    ]);
  });

  it('refuses an unquoted shell character instead of passing it through', () => {
    for (const run of ['claude -p | tee log', 'a $HOME', 'a `b`', 'a; b', 'a > out', 'a && b']) {
      expect(() => splitCommandLine(run)).toThrow(/unquoted ".*started without a shell/);
    }
    expect(splitCommandLine('a "|" \'$HOME\' "Bash(git:*)"')).toEqual([
      'a',
      '|',
      '$HOME',
      'Bash(git:*)',
    ]);
  });

  it('refuses an unterminated quote and an empty command', () => {
    expect(() => splitCommandLine('a "b')).toThrow(/unterminated " quote/);
    expect(() => splitCommandLine('   ')).toThrow(/empty/);
  });
});
