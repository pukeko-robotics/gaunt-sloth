import { beforeEach, describe, expect, it, vi } from 'vitest';

// systemUtils supplies the env the default secret collection reads; keep it empty and inject
// explicit secrets per test so the suite is deterministic.
const systemUtilsMock = {
  env: {} as Record<string, string | undefined>,
};
vi.mock('#src/utils/systemUtils.js', () => systemUtilsMock);

describe('toolDisplay (TUI-C30)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.resetModules();
    systemUtilsMock.env = {};
  });

  describe('summariseToolCall', () => {
    it('summarises key args inline as name(arg=val), not a raw JSON dump', async () => {
      const { summariseToolCall } = await import('#src/core/toolDisplay.js');
      expect(summariseToolCall('read_file', '{"path":"README.md"}', [])).toBe(
        'read_file(path=README.md)'
      );
    });

    it('renders name() for empty args and name(…) for unparsable/partial args', async () => {
      const { summariseToolCall } = await import('#src/core/toolDisplay.js');
      expect(summariseToolCall('run_tests', '{}', [])).toBe('run_tests()');
      expect(summariseToolCall('run_tests', undefined, [])).toBe('run_tests()');
      expect(summariseToolCall('read_file', '{"path":"RE', [])).toBe('read_file(…)');
    });

    it('falls back to (tool) when the name is unknown (placeholder call)', async () => {
      const { summariseToolCall } = await import('#src/core/toolDisplay.js');
      expect(summariseToolCall('', '{}', [])).toBe('(tool)()');
    });

    it('truncates over-long values with … at the per-value cap', async () => {
      const { summariseToolCall, TOOL_PARAM_VALUE_MAX_CHARS } =
        await import('#src/core/toolDisplay.js');
      const long = 'x'.repeat(200);
      const summary = summariseToolCall('read_file', JSON.stringify({ path: long }), []);
      expect(summary).toContain('…');
      expect(summary).not.toContain(long);
      expect(summary.length).toBeLessThan(TOOL_PARAM_VALUE_MAX_CHARS + 20);
    });

    it('caps the whole summary and collapses newlines so it stays one line', async () => {
      const { summariseToolCall, TOOL_SUMMARY_MAX_CHARS } =
        await import('#src/core/toolDisplay.js');
      const args = Object.fromEntries(
        Array.from({ length: 20 }, (_, i) => [`arg${i}`, `value number ${i}\nwith newline`])
      );
      const summary = summariseToolCall('mystery_tool', JSON.stringify(args), []);
      expect(summary).not.toContain('\n');
      expect(summary.length).toBeLessThanOrEqual('mystery_tool()'.length + TOOL_SUMMARY_MAX_CHARS);
      expect(summary).toContain('…');
    });

    it('summarises only the registry-selected args and marks elided ones with …', async () => {
      const { summariseToolCall } = await import('#src/core/toolDisplay.js');
      const summary = summariseToolCall(
        'write_file',
        JSON.stringify({ path: 'a.txt', content: 'SECRET BODY CONTENT' }),
        []
      );
      expect(summary).toBe('write_file(path=a.txt, …)');
      expect(summary).not.toContain('SECRET BODY CONTENT');
    });

    it('redacts provider-key-shaped values (GS2-47 pattern lineage)', async () => {
      const { summariseToolCall } = await import('#src/core/toolDisplay.js');
      const summary = summariseToolCall(
        'gth_web_fetch',
        JSON.stringify({ url: 'https://x.test', key: 'sk-abcdefghijklmnopqrstuvwx' }),
        []
      );
      expect(summary).toContain('<redacted>');
      expect(summary).not.toContain('sk-abcdefghijklmnopqrstuvwx');
    });

    it('substitutes known secret literals from the provided secrets list', async () => {
      const { summariseToolCall } = await import('#src/core/toolDisplay.js');
      const summary = summariseToolCall('echo_tool', JSON.stringify({ text: 'my-secret-value' }), [
        'my-secret-value',
      ]);
      expect(summary).toBe('echo_tool(text=<redacted>)');
    });

    it('defaults its secrets to env vars with secret-shaped names', async () => {
      systemUtilsMock.env = { MY_PROVIDER_API_KEY: 'env-secret-literal-1' };
      const { summariseToolCall } = await import('#src/core/toolDisplay.js');
      const summary = summariseToolCall(
        'echo_tool',
        JSON.stringify({ text: 'env-secret-literal-1' })
      );
      expect(summary).toBe('echo_tool(text=<redacted>)');
    });

    // fix-cycle-1 regression — redaction must run BEFORE truncation. A literal secret longer
    // than the per-value cap that matches no provider pattern (a bare 64-char hex token) would
    // otherwise be bisected by the cut, stop literal-matching, and leak its head.
    it('fully redacts a patternless literal secret LONGER than the value cap', async () => {
      const { summariseToolCall, TOOL_PARAM_VALUE_MAX_CHARS } =
        await import('#src/core/toolDisplay.js');
      const secret = 'deadbeef'.repeat(8); // 64 chars, no provider-pattern prefix
      expect(secret.length).toBeGreaterThan(TOOL_PARAM_VALUE_MAX_CHARS);
      const summary = summariseToolCall('echo_tool', JSON.stringify({ token: secret }), [secret]);
      expect(summary).toBe('echo_tool(token=<redacted>)');
      expect(summary).not.toContain(secret.slice(0, 12)); // no leaked head
    });

    it('fully redacts an over-cap secret sourced from a secret-named env var (default path)', async () => {
      const secret = 'cafebabe'.repeat(8); // 64 chars, patternless
      systemUtilsMock.env = { LONG_SERVICE_TOKEN: secret };
      const { summariseToolCall } = await import('#src/core/toolDisplay.js');
      const summary = summariseToolCall('echo_tool', JSON.stringify({ auth: secret }));
      expect(summary).toBe('echo_tool(auth=<redacted>)');
      expect(summary).not.toContain('cafebabe');
    });

    it('the whole-summary cap cannot bisect a secret out of matching either', async () => {
      const { summariseToolCall, TOOL_SUMMARY_MAX_CHARS } =
        await import('#src/core/toolDisplay.js');
      const secret = 'feedface'.repeat(5); // 40 chars — under the per-value cap, so it survives
      // Two padded args push the joined summary past the 120 cap with the secret STRADDLING the
      // boundary (2+48+2 + 2+48+2 + 6 = 110 chars before the token value starts).
      const summary = summariseToolCall(
        'echo_tool',
        JSON.stringify({ a: 'x'.repeat(60), b: 'y'.repeat(60), token: secret }),
        [secret]
      );
      expect(summary).not.toContain('feedface'); // neither whole nor bisected head survives
      expect(summary.length).toBeLessThanOrEqual('echo_tool()'.length + TOOL_SUMMARY_MAX_CHARS);
    });
  });

  describe('capToolDisplayLines (the canonical 10-line cap)', () => {
    it('returns short bodies unchanged (no marker)', async () => {
      const { capToolDisplayLines } = await import('#src/core/toolDisplay.js');
      const lines = Array.from({ length: 10 }, (_, i) => ({
        text: `l${i}`,
        style: 'dim' as const,
      }));
      expect(capToolDisplayLines(lines)).toEqual(lines);
    });

    it('caps at 10 lines and appends a dim overflow marker naming the hidden count', async () => {
      const { capToolDisplayLines, TOOL_OUTPUT_PREVIEW_LINES } =
        await import('#src/core/toolDisplay.js');
      const lines = Array.from({ length: 25 }, (_, i) => ({
        text: `l${i}`,
        style: 'dim' as const,
      }));
      const capped = capToolDisplayLines(lines);
      expect(TOOL_OUTPUT_PREVIEW_LINES).toBe(10);
      expect(capped).toHaveLength(11); // 10 + the marker
      expect(capped[9].text).toBe('l9');
      expect(capped[10]).toEqual({ text: '… (+15 more lines)', style: 'dim' });
    });

    it('char-caps an over-long single line with …', async () => {
      const { capToolDisplayLines, TOOL_PREVIEW_LINE_MAX_CHARS } =
        await import('#src/core/toolDisplay.js');
      const capped = capToolDisplayLines([{ text: 'y'.repeat(500), style: 'dim' }]);
      expect(capped[0].text.length).toBeLessThanOrEqual(TOOL_PREVIEW_LINE_MAX_CHARS);
      expect(capped[0].text.endsWith('…')).toBe(true);
    });

    it('uses the singular marker for exactly one hidden line', async () => {
      const { capToolDisplayLines } = await import('#src/core/toolDisplay.js');
      const lines = Array.from({ length: 11 }, (_, i) => ({
        text: `l${i}`,
        style: 'dim' as const,
      }));
      expect(capToolDisplayLines(lines)[10].text).toBe('… (+1 more line)');
    });
  });

  describe('buildToolBodyLines — generic fallback', () => {
    it('renders live output then the result as dim lines', async () => {
      const { buildToolBodyLines } = await import('#src/core/toolDisplay.js');
      const lines = buildToolBodyLines(
        { name: 'my_tool', output: 'out-1\nout-2\n', result: 'res-1' },
        []
      );
      expect(lines).toEqual([
        { text: 'out-1', style: 'dim' },
        { text: 'out-2', style: 'dim' },
        { text: 'res-1', style: 'dim' },
      ]);
    });

    it('redacts secret literals in body lines', async () => {
      const { buildToolBodyLines } = await import('#src/core/toolDisplay.js');
      const lines = buildToolBodyLines({ name: 'my_tool', result: 'token is literal-secret-9' }, [
        'literal-secret-9',
      ]);
      expect(lines[0].text).toBe('token is <redacted>');
    });
  });

  describe('buildToolBodyLines — shell-shaped results (<COMMAND_OUTPUT>)', () => {
    const shellResult =
      "Executing 'ls'...\n\n<COMMAND_OUTPUT>\nfile-a\nfile-b\n</COMMAND_OUTPUT>\n" +
      "\n\nCommand 'ls' completed successfully";

    it('extracts the output body + closing status, dropping the wrapper tags', async () => {
      const { buildToolBodyLines } = await import('#src/core/toolDisplay.js');
      const lines = buildToolBodyLines({ name: 'run_shell_command', result: shellResult }, []);
      expect(lines.map((l) => l.text)).toEqual([
        'file-a',
        'file-b',
        "Command 'ls' completed successfully",
      ]);
    });

    it('prefers the LIVE output over the result body (TUI-C17 dedupe) when both exist', async () => {
      const { buildToolBodyLines } = await import('#src/core/toolDisplay.js');
      const lines = buildToolBodyLines(
        { name: 'run_shell_command', output: 'live-a\n', result: shellResult },
        []
      );
      expect(lines.map((l) => l.text)).toEqual(['live-a', "Command 'ls' completed successfully"]);
    });

    it('renders only the status tail when live output already streamed raw (plain surface)', async () => {
      const { buildToolBodyLines } = await import('#src/core/toolDisplay.js');
      const lines = buildToolBodyLines(
        { name: 'run_shell_command', result: shellResult, liveOutputAlreadyShown: true },
        []
      );
      expect(lines.map((l) => l.text)).toEqual(["Command 'ls' completed successfully"]);
    });

    it('detects the shape for custom (unregistered) tool names too', async () => {
      const { buildToolBodyLines } = await import('#src/core/toolDisplay.js');
      const lines = buildToolBodyLines(
        { name: 'my_custom_build', result: shellResult, liveOutputAlreadyShown: true },
        []
      );
      expect(lines.map((l) => l.text)).toEqual(["Command 'ls' completed successfully"]);
    });
  });

  describe('buildToolBodyLines — write_file / edit_file diffs from args', () => {
    it('write_file: every content line becomes an added (+) line, result as dim tail', async () => {
      const { buildToolBodyLines } = await import('#src/core/toolDisplay.js');
      const lines = buildToolBodyLines(
        {
          name: 'write_file',
          argsText: JSON.stringify({ path: 'a.txt', content: 'one\ntwo' }),
          result: 'Successfully wrote to a.txt',
        },
        []
      );
      expect(lines).toEqual([
        { text: '+ one', style: 'added' },
        { text: '+ two', style: 'added' },
        { text: 'Successfully wrote to a.txt', style: 'dim' },
      ]);
    });

    it('edit_file: removed oldText lines then added newText lines, per edit', async () => {
      const { buildToolBodyLines } = await import('#src/core/toolDisplay.js');
      const lines = buildToolBodyLines(
        {
          name: 'edit_file',
          argsText: JSON.stringify({
            path: 'a.ts',
            edits: [
              { oldText: 'old-1', newText: 'new-1' },
              { oldText: 'old-2a\nold-2b', newText: 'new-2' },
            ],
          }),
        },
        []
      );
      expect(lines).toEqual([
        { text: '- old-1', style: 'removed' },
        { text: '+ new-1', style: 'added' },
        { text: '…', style: 'dim' }, // hunk separator between edits
        { text: '- old-2a', style: 'removed' },
        { text: '- old-2b', style: 'removed' },
        { text: '+ new-2', style: 'added' },
      ]);
    });

    it('falls back to the generic (error text) rendering when the call errored', async () => {
      const { buildToolBodyLines } = await import('#src/core/toolDisplay.js');
      const lines = buildToolBodyLines(
        {
          name: 'edit_file',
          argsText: JSON.stringify({ path: 'a.ts', edits: [{ oldText: 'x', newText: 'y' }] }),
          result: 'Could not find exact match for edit:\nx',
          isError: true,
        },
        []
      );
      expect(lines.every((l) => l.style === 'dim')).toBe(true);
      expect(lines[0].text).toContain('Could not find exact match');
    });

    it('falls back to generic when the args are unparsable mid-stream', async () => {
      const { buildToolBodyLines } = await import('#src/core/toolDisplay.js');
      const lines = buildToolBodyLines({ name: 'write_file', argsText: '{"path":"a.t' }, []);
      expect(lines).toEqual([]);
    });
  });

  describe('renderToolLineAnsi (plain-surface colour adapter)', () => {
    it('self-styles each line (dim/green/red + reset) when colour is on', async () => {
      const { renderToolLineAnsi } = await import('#src/core/toolDisplay.js');
      expect(renderToolLineAnsi({ text: 'x', style: 'dim' }, true)).toBe('\x1b[2mx\x1b[0m');
      expect(renderToolLineAnsi({ text: '+ x', style: 'added' }, true)).toBe('\x1b[32m+ x\x1b[0m');
      expect(renderToolLineAnsi({ text: '- x', style: 'removed' }, true)).toBe(
        '\x1b[31m- x\x1b[0m'
      );
    });

    it('degrades to clean monochrome (raw text, diff prefixes intact) when colour is off', async () => {
      const { renderToolLineAnsi } = await import('#src/core/toolDisplay.js');
      expect(renderToolLineAnsi({ text: '+ x', style: 'added' }, false)).toBe('+ x');
      expect(renderToolLineAnsi({ text: '- x', style: 'removed' }, false)).toBe('- x');
    });
  });

  describe('buildToolPreviewLines', () => {
    it('is the body capped at the canonical 10 lines', async () => {
      const { buildToolPreviewLines } = await import('#src/core/toolDisplay.js');
      const result = Array.from({ length: 30 }, (_, i) => `r${i}`).join('\n');
      const preview = buildToolPreviewLines({ name: 'read_file', result }, []);
      expect(preview).toHaveLength(11);
      expect(preview[10].text).toBe('… (+20 more lines)');
    });
  });

  describe('getToolGlyph', () => {
    it('maps registry names and falls back to the generic glyph', async () => {
      const { getToolGlyph } = await import('#src/core/toolDisplay.js');
      expect(getToolGlyph('read_file')).toBe('📁');
      expect(getToolGlyph('run_shell_command')).toBe('🔧');
      expect(getToolGlyph('never_heard_of_it')).toBe('⚙');
    });
  });

  // TUI-C32 residual a — getDefaultSecrets used to pass `undefined` for the config, skipping the
  // GS2-47 config walk, so an INLINE config secret (a pasted key/token that matches no provider
  // pattern) was never collected and so never literal-redacted. setToolDisplayConfig wires the live
  // config back in.
  describe('setToolDisplayConfig — inline config secret collection (TUI-C32 residual a)', () => {
    it('redacts an inline config apiKey (patternless, config-only) in a summary', async () => {
      const { summariseToolCall, setToolDisplayConfig } = await import('#src/core/toolDisplay.js');
      // ≥6 chars, matches NO provider pattern, and lives ONLY in config (env is mocked empty) — so
      // the config walk is the only path that can collect it. That path is exactly residual a.
      const inlineSecret = 'inline-config-secret-value';
      setToolDisplayConfig({ llm: { apiKey: inlineSecret } });
      const summary = summariseToolCall('echo_tool', JSON.stringify({ text: inlineSecret }));
      expect(summary).toBe('echo_tool(text=<redacted>)');
      expect(summary).not.toContain('inline-config-secret-value');
    });
  });

  // TUI-C32 residual c — the shell body formatter/dedupe must key on tool NAME + shape, not shape
  // alone, so a NON-shell tool whose result merely contains the `<COMMAND_OUTPUT>` marker is not
  // mis-treated as shell (its body stripped of tags + pre-marker prefix).
  describe('shell-shape is name-gated (TUI-C32 residual c)', () => {
    const shellResult =
      "Executing 'ls'...\n\n<COMMAND_OUTPUT>\nfile-a\n</COMMAND_OUTPUT>\n\n\nCommand 'ls' done";

    it('does NOT shell-parse a registered non-shell tool whose result contains <COMMAND_OUTPUT>', async () => {
      const { buildToolBodyLines } = await import('#src/core/toolDisplay.js');
      // read_file returning a file that quotes the marker: the shell parser would drop the
      // "preamble" line and the wrapper tags; the generic render keeps the whole result verbatim.
      const fileContent = 'preamble line\n<COMMAND_OUTPUT>\ninner\n</COMMAND_OUTPUT>\ntail line';
      const lines = buildToolBodyLines({ name: 'read_file', result: fileContent }, []);
      expect(lines.map((l) => l.text)).toEqual([
        'preamble line',
        '<COMMAND_OUTPUT>',
        'inner',
        '</COMMAND_OUTPUT>',
        'tail line',
      ]);
    });

    it('isShellShapedResult: true for a flagged shell tool, false for a registered non-shell one, shape for custom', async () => {
      const { isShellShapedResult } = await import('#src/core/toolDisplay.js');
      expect(isShellShapedResult('run_shell_command', shellResult)).toBe(true);
      expect(isShellShapedResult('read_file', shellResult)).toBe(false); // registered, not shell
      expect(isShellShapedResult('my_custom_build', shellResult)).toBe(true); // custom → shape
      expect(isShellShapedResult('run_shell_command', 'plain result, no marker')).toBe(false);
    });
  });

  // TUI-C32 residual d — the expanded-panel dedupe used to trust live-output completeness: if the
  // streamed `output` was non-empty at all, the result's `<COMMAND_OUTPUT>` copy was never rendered.
  // A live channel that dropped straggler/tail chunks was then unrecoverable. Fall back to the fuller
  // result copy when the live output is a strict prefix of it.
  describe('expanded-panel shell dedupe reconciles a truncated live stream (TUI-C32 residual d)', () => {
    it('falls back to the fuller result <COMMAND_OUTPUT> copy when live output is a truncated prefix', async () => {
      const { buildToolBodyLines } = await import('#src/core/toolDisplay.js');
      // The live channel dropped the tail: streamed output is a strict PREFIX of the model-facing
      // copy (the realistic post-TUI-C31 straggler-loss case).
      const liveOutput = 'file-a\nfile-b\n';
      const fullResult =
        "Executing 'ls'...\n\n<COMMAND_OUTPUT>\nfile-a\nfile-b\nfile-c\nfile-d\n</COMMAND_OUTPUT>\n" +
        "\n\nCommand 'ls' completed successfully";
      const lines = buildToolBodyLines(
        { name: 'run_shell_command', output: liveOutput, result: fullResult },
        []
      );
      expect(lines.map((l) => l.text)).toEqual([
        'file-a',
        'file-b',
        'file-c', // recovered from the result copy — absent from the truncated live stream
        'file-d',
        "Command 'ls' completed successfully",
      ]);
    });
  });
});
