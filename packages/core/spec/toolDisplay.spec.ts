import stringWidth from 'string-width';
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
      // The caps are COLUMN budgets, so the bound is measured in columns — on an ASCII fixture
      // the two coincide, and a `.length` bound would silently double the moment one does not.
      expect(stringWidth(summary)).toBeLessThan(TOOL_PARAM_VALUE_MAX_CHARS + 20);
    });

    it('caps a CJK value by terminal COLUMNS rather than code points (TUI-C34)', async () => {
      const { summariseToolCall } = await import('#src/core/toolDisplay.js');
      // 33 code points, 56 columns: it fits the 48-column value cap only by count, so a code-point
      // cap hands the whole path back and the summary over-runs the row it is rendered on.
      const path = '/プロジェクト/ドキュメント/設定/読み込み/テスト/深層.txt';
      // The kept head is 47 columns and `…` is the 48th — the whole cap, and no more.
      expect(summariseToolCall('read_file', JSON.stringify({ path }), [])).toBe(
        'read_file(path=/プロジェクト/ドキュメント/設定/読み込み/テスト…)'
      );
    });

    // What this pins is that the summary is ONE line, not the mechanism that keeps it one: since
    // TUI-C102 a newline is escaped to a visible `\x0a` rather than collapsed to a space, which the
    // approval dialog has always done for the same string and the same reason.
    it('caps the whole summary and keeps newlines off it so it stays one line', async () => {
      const { summariseToolCall, TOOL_SUMMARY_MAX_CHARS } =
        await import('#src/core/toolDisplay.js');
      const args = Object.fromEntries(
        Array.from({ length: 20 }, (_, i) => [`arg${i}`, `value number ${i}\nwith newline`])
      );
      const summary = summariseToolCall('mystery_tool', JSON.stringify(args), []);
      expect(summary).not.toContain('\n');
      expect(stringWidth(summary)).toBeLessThanOrEqual(
        stringWidth('mystery_tool()') + TOOL_SUMMARY_MAX_CHARS
      );
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
      expect(stringWidth(secret)).toBeGreaterThan(TOOL_PARAM_VALUE_MAX_CHARS);
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
      expect(stringWidth(summary)).toBeLessThanOrEqual(
        stringWidth('echo_tool()') + TOOL_SUMMARY_MAX_CHARS
      );
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

    it('caps an over-long single line at the per-line COLUMN budget with …', async () => {
      const { capToolDisplayLines, TOOL_PREVIEW_LINE_MAX_CHARS } =
        await import('#src/core/toolDisplay.js');
      const capped = capToolDisplayLines([{ text: 'y'.repeat(500), style: 'dim' }]);
      expect(stringWidth(capped[0].text)).toBeLessThanOrEqual(TOOL_PREVIEW_LINE_MAX_CHARS);
      expect(capped[0].text.endsWith('…')).toBe(true);

      // The same cap on a CJK line, which is half as many code points as it is columns: 99 whole
      // two-column clusters (198) plus the marker (1) is the whole 200-column budget bar the odd
      // column no wide glyph can fill — a unit-counting cap would draw it twice that wide.
      const wide = capToolDisplayLines([{ text: '設定'.repeat(300), style: 'dim' }]);
      expect(stringWidth(wide[0].text)).toBe(TOOL_PREVIEW_LINE_MAX_CHARS - 1);
      expect(wide[0].text.endsWith('…')).toBe(true);
    });

    it('leaves a COLOURED line that visibly fits the cap alone, and still caps one that does not', async () => {
      const { capToolDisplayLines, TOOL_PREVIEW_LINE_MAX_CHARS } =
        await import('#src/core/toolDisplay.js');
      // Shell output arrives coloured. 180 visible columns under the 200-column cap, but 380
      // once the escapes' own printable bytes are counted — so whether this line fits has to be
      // decided by what it RENDERS as, or a fitting line comes back cut by its own escapes.
      const coloured = '\x1b[32m'.repeat(50) + 'a'.repeat(180);
      expect(stringWidth(coloured)).toBeLessThan(TOOL_PREVIEW_LINE_MAX_CHARS);
      expect(capToolDisplayLines([{ text: coloured, style: 'dim' }])[0].text).toBe(coloured);

      // …and the cap still bites on a coloured line that genuinely over-runs, so this is not
      // "coloured input is exempt".
      const over = capToolDisplayLines([{ text: '\x1b[32m' + 'a'.repeat(400), style: 'dim' }])[0]
        .text;
      expect(stringWidth(over)).toBeLessThanOrEqual(TOOL_PREVIEW_LINE_MAX_CHARS);
      expect(over.endsWith('…')).toBe(true);
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

  // TUI-C102 — a tool RESULT is untrusted text (a file's bytes, a fetched page, an MCP server's
  // response, a command's stdout), and it was the one untrusted surface in the product that
  // reached a terminal with its control characters intact. The hazard is not defacement but
  // FORGERY NEXT TO A DECISION: SGR colour plus cursor positioning lets attacker-controlled bytes
  // paint something shaped like gsloth's own approval prompt a few rows from the real one, and
  // TUI-C99 makes this display path the primary route by which a human inspects a call they are
  // being asked to permit.
  //
  // Every case here asserts the EXACT rendered text, not merely the absence of control characters:
  // a step that DROPPED the bytes would satisfy an absence check while destroying the thing the
  // human is ruling on. The neutraliser makes text visible and inert; it never sanitises.
  describe('TUI-C102 — untrusted tool text is neutralised before it reaches a terminal', () => {
    /** The class `neutralizeUntrustedText` covers: control, format, line and paragraph separators. */
    const CONTROL_OR_FORMAT = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

    /** The hostile result the tracked TUI-C102 probe drives, verbatim. */
    const HOSTILE = [
      'benign first line',
      '\x1b[2J\x1b[H  <- clear screen + cursor home',
      '\x1b[31mforged red\x1b[0m  <- SGR colour',
      '\x1b]0;RETITLED\x07  <- OSC window-title set',
      'bell:\x07 backspace:\x08 vertical-tab:\x0b',
      '\x1b[1000Boverdraw  <- cursor move down 1000',
    ].join('\n');

    const NEUTRALISED = [
      'benign first line',
      '\\x1b[2J\\x1b[H  <- clear screen + cursor home',
      '\\x1b[31mforged red\\x1b[0m  <- SGR colour',
      '\\x1b]0;RETITLED\\x07  <- OSC window-title set',
      'bell:\\x07 backspace:\\x08 vertical-tab:\\x0b',
      '\\x1b[1000Boverdraw  <- cursor move down 1000',
    ];

    it('renders ESC, OSC, BEL, BS, VT and cursor moves visible and inert — in the collapsed preview AND the Ctrl+T expansion', async () => {
      const { buildToolBodyLines, buildToolPreviewLines } =
        await import('#src/core/toolDisplay.js');
      const input = { name: 'read_file', result: HOSTILE };
      // Both surfaces' entry points, because the collapsed row and the expansion are two different
      // functions and a fix placed in one of them leaves the other painting raw escapes.
      for (const lines of [buildToolBodyLines(input, []), buildToolPreviewLines(input, [])]) {
        expect(lines.map((l) => l.text)).toEqual(NEUTRALISED);
        for (const line of lines) expect(line.text).not.toMatch(CONTROL_OR_FORMAT);
      }
    });

    it('composes redaction, neutralisation and the width cap on ONE line that needs all three', async () => {
      const { buildToolPreviewLines, TOOL_PREVIEW_LINE_MAX_CHARS } =
        await import('#src/core/toolDisplay.js');
      // The secret literal CONTAINS a control character on purpose. That is the only input able to
      // tell redact-then-neutralise from neutralise-then-redact: rewrite the control character
      // first and the literal stops matching, so `tok…` renders and the secret partially leaks.
      // Three green rows elsewhere would not catch that — only this composition does.
      const secret = 'tok\x0bliteral-secret-value';
      const result = `head ${secret} tail \x1b[2J ` + 'z'.repeat(400);
      const preview = buildToolPreviewLines({ name: 'read_file', result }, [secret]);
      expect(preview).toHaveLength(1);
      const text = preview[0].text;
      // (a) the secret is gone WHOLE — no bisected head survives
      expect(text).toContain('<redacted>');
      expect(text).not.toContain('tok');
      expect(text).not.toContain('literal-secret-value');
      // (b) the control characters are visible and inert
      expect(text).toContain('\\x1b[2J');
      expect(text).not.toMatch(CONTROL_OR_FORMAT);
      // (c) and the line still fits its budget. The cap measures what a line RENDERS as; the
      // escapes it used to discount are gone by the time it looks, so the measured width and the
      // sliced text are the same string — which is the property that breaks if the neutralisation
      // step is ever moved after the cap.
      expect(stringWidth(text)).toBeLessThanOrEqual(TOOL_PREVIEW_LINE_MAX_CHARS);
      expect(text.endsWith('…')).toBe(true);
    });

    it('neutralises the CALL SUMMARY too — the row TUI-C99 turns into the approval row', async () => {
      const { summariseToolCall } = await import('#src/core/toolDisplay.js');
      // Whitespace-collapsing is not neutralisation: JavaScript's `\s` covers LF, CR and TAB but
      // not ESC, BEL, the C1 range or the bidi overrides, so a screen-clear reached the terminal
      // through the summary of a refused command — the exact shape the approval suite's own
      // fixtures ship (`framingCommands.mjs`).
      const summary = summariseToolCall(
        'run_shell_command',
        JSON.stringify({ command: 'echo start\x1b[2J\x1b[A end' }),
        []
      );
      expect(summary).toBe('run_shell_command(command=echo start\\x1b[2J\\x1b[A end)');
      expect(summary).not.toMatch(CONTROL_OR_FORMAT);
    });

    it('neutralises the tool NAME and the arg KEYS as well — an MCP server names its own tools', async () => {
      const { summariseToolCall } = await import('#src/core/toolDisplay.js');
      const summary = summariseToolCall('evil\x1b[2Jtool', JSON.stringify({ 'k\x07ey': 'v' }), []);
      expect(summary).toBe('evil\\x1b[2Jtool(k\\x07ey=v)');
      expect(summary).not.toMatch(CONTROL_OR_FORMAT);
    });

    it("keeps the renderer's OWN styling while the content it wraps is neutralised", async () => {
      const { buildToolBodyLines, renderToolLineAnsi } = await import('#src/core/toolDisplay.js');
      const lines = buildToolBodyLines(
        {
          name: 'write_file',
          argsText: JSON.stringify({ path: 'a.txt', content: 'ok\x1b[31mred' }),
        },
        []
      );
      expect(lines[0]).toEqual({ text: '+ ok\\x1b[31mred', style: 'added' });
      // The only real escapes in the plain surface's output are the ones the ADAPTER adds: its own
      // SGR open and reset, around neutralised content. Neutralise the content, never the styling.
      expect(renderToolLineAnsi(lines[0], true)).toBe('\x1b[32m+ ok\\x1b[31mred\x1b[0m');
      expect(renderToolLineAnsi(lines[0], false)).toBe('+ ok\\x1b[31mred');
      expect(renderToolLineAnsi({ text: 'x', style: 'dim' }, true)).toBe('\x1b[2mx\x1b[0m');
      expect(renderToolLineAnsi({ text: '- x', style: 'removed' }, true)).toBe(
        '\x1b[31m- x\x1b[0m'
      );
    });

    it('still redacts a secret on a line that also carries control characters', async () => {
      const { buildToolBodyLines } = await import('#src/core/toolDisplay.js');
      const lines = buildToolBodyLines(
        { name: 'read_file', result: 'key=plain-secret-1\x07 and \x1b[2J more' },
        ['plain-secret-1']
      );
      expect(lines.map((l) => l.text)).toEqual(['key=<redacted>\\x07 and \\x1b[2J more']);
    });

    // THE RULE `toLines` IMPLEMENTS: `\r\n` is one line break; a lone `\r` is not a break and
    // reaches the neutraliser, which draws it as a visible `\x0d`.
    //
    // It is `splitLogicalLines` in `core/shell/framing` — the approval path's own splitter,
    // matched rather than re-decided, because this node exists to stop the tool path and the
    // approval path disagreeing about what is inert. It weakens nothing: the attack is the LONE
    // carriage return, the cursor-to-column-0 overwrite that paints forged chrome over a row a
    // human is reading, and that is still made visible. Only the pair every terminal already
    // draws as one break stops being reported — without which every line of every Windows-authored
    // file would end in a `\x0d` once the body is neutralised.
    //
    // Both halves are asserted together because only the pair pins the rule: the first alone
    // passes if the splitter breaks on any `\r`, and the second alone passes if it breaks on none.
    it('treats CRLF as one break while a lone CR stays visible — the two halves of the same rule', async () => {
      const { buildToolBodyLines } = await import('#src/core/toolDisplay.js');
      // A Windows-authored file reads clean: the `\r` belonged to the break, and went with it.
      expect(
        buildToolBodyLines({ name: 'read_file', result: 'line one\r\nline two\r\n' }, []).map(
          (l) => l.text
        )
      ).toEqual(['line one', 'line two']);
      // A bare CR cannot return to column 0 and overwrite the row with forged chrome — it is on
      // the screen, saying what it is.
      expect(
        buildToolBodyLines({ name: 'read_file', result: 'safe text\rApprove? [o]nce' }, []).map(
          (l) => l.text
        )
      ).toEqual(['safe text\\x0dApprove? [o]nce']);
    });

    // The Ctrl+T expansion paints two strings that never pass through `buildToolBodyLines`: the
    // raw streamed args text and the routed notice. Both are untrusted — `argsText` is whatever
    // the model streamed, and for a shell call it IS the command — and under TUI-C99 this is the
    // panel a human reads while deciding whether to permit that call.
    it('neutralises the EXPANSION strings the body path never sees — raw args and the routed notice', async () => {
      const { buildToolExpansionText } = await import('#src/core/toolDisplay.js');
      // Written as a raw buffer, not through `JSON.stringify`, because that is what this field
      // holds: the args text is accumulated `tool_args` deltas exactly as the model streamed them.
      // Well-formed JSON would escape a control character itself; nothing guarantees well-formed,
      // and a half-streamed buffer is the normal case while the call is still arriving.
      const expansion = buildToolExpansionText(
        {
          argsText: '{"command":"echo hi\x1b[2J\x1b[H","token":"expansion-secret-1"}',
          notice: '🔧 Executing run_shell_command: echo\x07 a\r\nb\rApprove? [o]nce',
        },
        ['expansion-secret-1']
      );
      // The args row: escapes visible, the secret redacted (the collapsed summary above this row
      // already redacts, so an expansion that did not would leak under `/verbose` what the row
      // above it hid).
      expect(expansion.args).toBe('{"command":"echo hi\\x1b[2J\\x1b[H","token":"<redacted>"}');
      expect(expansion.args).not.toMatch(CONTROL_OR_FORMAT);
      // The notice: `toLines`' rule, so the CRLF is a break and the lone CR is visible.
      expect(expansion.noticeLines).toEqual([
        '🔧 Executing run_shell_command: echo\\x07 a',
        'b\\x0dApprove? [o]nce',
      ]);
      for (const line of expansion.noticeLines) expect(line).not.toMatch(CONTROL_OR_FORMAT);
    });

    it('returns nothing to paint for a call with neither args nor a notice', async () => {
      const { buildToolExpansionText } = await import('#src/core/toolDisplay.js');
      expect(buildToolExpansionText({}, [])).toEqual({ args: null, noticeLines: [] });
      expect(buildToolExpansionText({ argsText: '', notice: '' }, [])).toEqual({
        args: null,
        noticeLines: [],
      });
    });
  });
});
