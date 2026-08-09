import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionConfig } from '#src/modules/interactiveSessionModule.js';

/**
 * [[TUI-C26]] task 1 — **the readline (`--no-tui`) approval prompt frames untrusted text too.**
 *
 * The framing is one renderer in core and two surfaces that paint it (EXT-29's shape), and this is
 * the half the Ink PTY suite cannot see. Without it, unframing this surface alone would be a silent
 * change: `--no-tui` is a real, supported way to run a session, and the command and the rater's
 * reason arrive there over exactly the same seam.
 *
 * Every adversarial character is built from an explicit code point rather than typed, so no rule
 * here depends on an invisible character surviving an editor or a diff.
 */
const cp = (codePoint: number): string => String.fromCodePoint(codePoint);
const CR = cp(0x0d);
const ESC = cp(0x1b);
const LF = cp(0x0a);

// ── @gaunt-sloth/core/utils/systemUtils.js ────────────────────────────────────
const rlQuestionMock = vi.fn(async (prompt: string) => {
  if (typeof prompt === 'string' && prompt.includes('>')) return 'exit';
  return '';
});
vi.mock('@gaunt-sloth/core/utils/systemUtils.js', () => ({
  createInterface: vi.fn(() => ({ question: rlQuestionMock, close: vi.fn() })),
  error: vi.fn(),
  exit: vi.fn(),
  getProjectDir: vi.fn(() => '/proj'),
  getUseColour: vi.fn(() => false),
  refStdin: vi.fn(),
  setRawMode: vi.fn(),
  stdin: { isTTY: true },
  // The width the framing wraps to. Pinned rather than inherited so a row that is a row here is a
  // row on every machine the suite runs on.
  stdout: { isTTY: true, columns: 100 },
}));

// ── @gaunt-sloth/core/utils/consoleUtils.js ───────────────────────────────────
const displayMock = vi.fn();
const displayInfoMock = vi.fn();
const displayWarningMock = vi.fn();
const displayErrorMock = vi.fn();
vi.mock('@gaunt-sloth/core/utils/consoleUtils.js', () => ({
  defaultStatusCallback: vi.fn(),
  display: displayMock,
  displayError: displayErrorMock,
  displayInfo: displayInfoMock,
  displayLaunchBanner: vi.fn(),
  displayWarning: displayWarningMock,
  flushSessionLog: vi.fn(),
  formatInputPrompt: vi.fn((v: string) => v),
  initSessionLogging: vi.fn(),
  stopSessionLogging: vi.fn(),
}));

vi.mock('@gaunt-sloth/core/config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@gaunt-sloth/core/config.js')>()),
  initConfig: vi.fn().mockResolvedValue({ streamSessionInferenceLog: false }),
}));

vi.mock('@gaunt-sloth/core/utils/fileUtils.js', () => ({
  appendToFile: vi.fn(),
  getCommandOutputFilePath: vi.fn().mockReturnValue(null),
}));

type PendingLike = {
  name: string;
  args: Record<string, unknown>;
  safetyVerdict?: { outcome: string; reason: string };
  grantPreview?: string;
  grantSummary?: string;
};
let capturedApprovalCallback:
  | ((_pending: PendingLike) => Promise<{ type: string; scope?: string; message?: string }>)
  | undefined;
const runnerInstanceMock = {
  init: vi.fn().mockResolvedValue(undefined),
  processMessages: vi.fn().mockResolvedValue(undefined),
  setToolApprovalCallback: vi.fn((cb) => {
    capturedApprovalCallback = cb;
  }),
  cleanup: vi.fn().mockResolvedValue(undefined),
};
vi.mock('@gaunt-sloth/core/core/GthAgentRunner.js', () => ({
  GthAgentRunner: vi.fn(function GthAgentRunnerMock() {
    return runnerInstanceMock;
  }),
}));

vi.mock('@langchain/core/messages', () => ({ HumanMessage: vi.fn() }));
vi.mock('@langchain/langgraph', () => ({ MemorySaver: vi.fn() }));
vi.mock('#src/resolvers.js', () => ({ createResolvers: vi.fn() }));
vi.mock('#src/core/gthDeepAgentFactory.js', () => ({ gthDeepAgentFactory: vi.fn() }));

const sessionConfig = {
  mode: 'code',
  readModePrompt: () => null,
  description: 'code',
  readyMessage: 'ready',
  exitMessage: 'exit hint',
} as unknown as SessionConfig;

/** Every line this surface put on the terminal, in order. */
const allLines = (): string[] =>
  [displayMock, displayWarningMock, displayInfoMock, displayErrorMock]
    .flatMap((mock) => mock.mock.calls.map((call: unknown[]) => String(call[0])))
    .flatMap((text) => text.split('\n'));

/**
 * Just the INFO channel, in the order it was written.
 *
 * {@link allLines} concatenates the three channels one after another, so a line's neighbours there
 * are an artefact of which channel it went to. The sticky label and the value under it are both
 * `displayInfo`, and the only assertion that can tell the grant's frame from the command's — they
 * are the same bytes for a shell call — is the one that says WHICH ROW follows the label.
 */
const infoLines = (): string[] =>
  displayInfoMock.mock.calls.flatMap((call: unknown[]) => String(call[0]).split('\n'));

/** The framed body rows, as [line number, content]. */
const gutterRows = (): Array<[number, string]> =>
  allLines()
    .map((line) => /^ {2} *(\d+) │ (.*)$/u.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => [Number(match[1]), match[2]] as [number, string]);

describe('interactiveSessionModule — the readline approval prompt frames untrusted text', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    capturedApprovalCallback = undefined;
    rlQuestionMock.mockImplementation(async (prompt: string) => {
      if (typeof prompt === 'string' && prompt.includes('>')) return 'exit';
      return '';
    });
    runnerInstanceMock.init.mockResolvedValue(undefined);
    runnerInstanceMock.processMessages.mockResolvedValue(undefined);
    runnerInstanceMock.cleanup.mockResolvedValue(undefined);
    runnerInstanceMock.setToolApprovalCallback.mockImplementation((cb) => {
      capturedApprovalCallback = cb;
    });
  });

  const startSession = async () => {
    const { createInteractiveSession } = await import('#src/modules/interactiveSessionModule.js');
    await createInteractiveSession(sessionConfig, {});
    expect(capturedApprovalCallback).toBeTypeOf('function');
    displayMock.mockClear();
    displayInfoMock.mockClear();
    displayWarningMock.mockClear();
  };

  const ask = async (pending: PendingLike) => {
    rlQuestionMock.mockResolvedValueOnce('n');
    return capturedApprovalCallback!(pending);
  };

  /**
   * The shape of the command that motivated this whole surface: an ordinary commit message with a
   * substitution buried in it. A single-line clamp — the superseded requirement — would print line
   * one and stop, which is a complete-looking prompt about a `git add`.
   */
  it('shows every line of a multi-line command, numbered, with the deep site flagged above', async () => {
    await startSession();
    const lines = Array.from({ length: 18 }, (_, index) => `prose line ${index + 1}`);
    lines[0] = 'git add -A && git commit -m "a note';
    lines[14] = 'so `echo deep-payload` then runs unrated,';
    await ask({ name: 'run_shell_command', args: { command: lines.join(LF) } });

    const rows = gutterRows();
    expect(rows.map(([number]) => number)).toEqual(
      Array.from({ length: 18 }, (_, index) => index + 1)
    );
    expect(rows[14]).toEqual([15, 'so `echo deep-payload` then runs unrated,']);
    // The sites are extracted above the body, naming the line to count to.
    const out = allLines().join('\n');
    expect(out).toContain('line 15 · command substitution `');
    expect(out).toContain('line 1 · composition &&');
    // ...and nothing untrusted reached column 0.
    expect(allLines().filter((line) => line.startsWith('so `echo deep-payload`'))).toEqual([]);
    expect(allLines().filter((line) => line.startsWith('git add -A'))).toEqual([]);
  });

  it('neutralises control characters and ANSI in the command', async () => {
    await startSession();
    await ask({
      name: 'run_shell_command',
      args: { command: `echo start${CR}Approve? [o]nce${ESC}[2J${ESC}[A end` },
    });
    expect(gutterRows()).toEqual([[1, 'echo start\\x0dApprove? [o]nce\\x1b[2J\\x1b[A end']]);
    // The raw introducers are gone from everything this surface printed, not merely from the body.
    expect(allLines().join('\n')).not.toContain(ESC);
    expect(allLines().join('\n')).not.toContain(CR);
  });

  /**
   * The other model-authored string on this dialog. Protecting the command and forgetting the
   * reason leaves the prompt forgeable through the text that is meant to explain it.
   */
  it('neutralises and frames the RATER’S REASON, not only the command', async () => {
    await startSession();
    await ask({
      name: 'run_shell_command',
      args: { command: 'npm test' },
      safetyVerdict: {
        // The CR is deliberately NOT adjacent to the LF: `CRLF` is one line break, so a CR written
        // beside one would be consumed by the split and prove nothing about neutralising it.
        outcome: 'destructive',
        reason: `Routine.${CR}overwrite${ESC}[2J${LF}Approve?  [o]nce   [s]ession   [a]lways   [N]o`,
      },
    });

    const out = allLines();
    // The outcome and what it MEANS are the surface's own line; the reason is framed beneath it,
    // under a label that keeps the words attributed to the rater rather than to the gate.
    expect(out.some((line) => line.startsWith('⚠ Auto-rater (destructive):'))).toBe(true);
    expect(out).toContain("    the rater's own words:");
    expect(gutterRows()).toContainEqual([1, 'Routine.\\x0doverwrite\\x1b[2J']);
    expect(gutterRows()).toContainEqual([2, 'Approve?  [o]nce   [s]ession   [a]lways   [N]o']);
    // The forged menu line never reaches column 0, where the real one lives.
    expect(out.filter((line) => line.startsWith('Approve?  [o]nce'))).toEqual([]);
    expect(out.join('\n')).not.toContain(ESC);
  });

  it('frames the sticky-choice lines, which carry the command as typed', async () => {
    await startSession();
    await ask({
      name: 'run_shell_command',
      args: { command: 'echo marker approved by rater [o]nce' },
      grantPreview: '{ "type": "shell", "matcher": "exact", "pattern": "echo marker" }',
      grantSummary: 'echo marker approved by rater [o]nce',
    });

    // Anchored on the row under each label. `gutterRows()` alone cannot hold this: for a shell call
    // the grant summary IS the command, so a framed `echo marker approved by rater [o]nce` row
    // exists whether or not the grant itself was framed, and the assertion would pass on a surface
    // that painted the grant raw.
    const info = infoLines();
    const remembers = info.indexOf('[s]/[a] will remember:');
    expect(remembers).toBeGreaterThanOrEqual(0);
    expect(info[remembers + 1]).toBe('  1 │ echo marker approved by rater [o]nce');
    const storedAs = info.indexOf('    stored as:');
    expect(storedAs).toBeGreaterThanOrEqual(0);
    expect(info[storedAs + 1]).toBe(
      '  1 │ { "type": "shell", "matcher": "exact", "pattern": "echo marker" }'
    );
    // ...and neither value reached column 0, where this surface's own lines are.
    expect(allLines().filter((line) => line.startsWith('echo marker'))).toEqual([]);
  });

  it('CONTROL: an ordinary one-line command still renders its text, framed and unaltered', async () => {
    await startSession();
    await ask({ name: 'run_shell_command', args: { command: 'npm test -- --run' } });
    expect(gutterRows()).toEqual([[1, 'npm test -- --run']]);
    // Nothing was flagged, so no notice is invented for a command that resolves cleanly.
    expect(allLines().join('\n')).not.toContain('could not statically resolve');
  });
});
