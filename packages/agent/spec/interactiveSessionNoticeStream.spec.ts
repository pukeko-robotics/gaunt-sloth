import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Console } from 'node:console';
import type { SessionConfig } from '#src/modules/interactiveSessionModule.js';

/**
 * [[EXT-165]] — **one command notice, one stream, on the readline surface.**
 *
 * `printNotice` is the second of the two notice renderers, and the reason this is one node rather
 * than a fix inside [[EXT-159]]: a change to the termination notice alone would leave two renderers
 * disagreeing about which stream a notice is written to. This drives the real session loop, through
 * the real command registry, so the claim is about the renderer as it actually runs rather than
 * about a helper called in isolation.
 *
 * ## Why this one does not mock `consoleUtils`
 *
 * The mapping from a helper to a file descriptor is the thing under test, so a mock of the helpers
 * replaces exactly the measurement with a fixture and every assertion below would pass on the
 * broken code. Here the real `consoleUtils` runs, `process.stdout.write` / `process.stderr.write`
 * are recorded, and `globalThis.console` is restored to a real `Console` over those two streams for
 * the window — Vitest swaps the global console for one that reports to its own UI, under which
 * nothing reaches a stream at all. {@link captureFds}'s CONTROL case is what proves it does not.
 */

const rlQuestionMock = vi.fn(async () => 'exit');

vi.mock('@gaunt-sloth/core/utils/systemUtils.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@gaunt-sloth/core/utils/systemUtils.js')>()),
  createInterface: vi.fn(() => ({ question: rlQuestionMock, close: vi.fn() })),
  // `log`/`warn`/`info`/`error` are deliberately NOT replaced: they are the console primitives
  // `consoleUtils` writes through, and stubbing one would silently empty every assertion here.
  exit: vi.fn(),
  getProjectDir: vi.fn(() => '/proj'),
  refStdin: vi.fn(),
  setRawMode: vi.fn(),
  stdin: { isTTY: true },
  // `isTTY: false` because the whole point is the surface that is NOT a terminal: on a terminal
  // both descriptors go to the same place and a torn notice looks whole.
  stdout: { isTTY: false, columns: 100 },
}));

vi.mock('@gaunt-sloth/core/config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@gaunt-sloth/core/config.js')>()),
  initConfig: vi.fn().mockResolvedValue({
    streamSessionInferenceLog: false,
    llm: { type: 'test-provider' },
    modelDisplayName: 'test-model',
  }),
}));

vi.mock('@gaunt-sloth/core/utils/fileUtils.js', () => ({
  appendToFile: vi.fn(),
  getCommandOutputFilePath: vi.fn().mockReturnValue(null),
}));

const runnerInstanceMock = {
  init: vi.fn().mockResolvedValue(undefined),
  processMessages: vi.fn().mockResolvedValue(undefined),
  setApprovalOutcomeCallback: vi.fn(),
  setToolApprovalCallback: vi.fn(),
  setNegotiationDisplay: vi.fn(),
  setAttackHaltCallback: vi.fn(),
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

const sessionConfig = {
  mode: 'code',
  readModePrompt: () => null,
  description: 'code',
  readyMessage: 'ready',
  exitMessage: 'exit hint',
} as unknown as SessionConfig;

/** One write, and the file descriptor it went to. */
interface Written {
  fd: 1 | 2;
  text: string;
}

/**
 * Run `body` with both process streams recorded and a REAL console bound to them, then put
 * everything back.
 */
const captureFds = async (body: () => Promise<void> | void): Promise<Written[]> => {
  const written: Written[] = [];
  const realConsole = globalThis.console;
  const realStdoutWrite = process.stdout.write;
  const realStderrWrite = process.stderr.write;
  process.stdout.write = ((chunk: unknown) => {
    written.push({ fd: 1, text: String(chunk) });
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown) => {
    written.push({ fd: 2, text: String(chunk) });
    return true;
  }) as typeof process.stderr.write;
  globalThis.console = new Console({ stdout: process.stdout, stderr: process.stderr });
  try {
    await body();
  } finally {
    globalThis.console = realConsole;
    process.stdout.write = realStdoutWrite;
    process.stderr.write = realStderrWrite;
  }
  return written;
};

/** Everything that reached one descriptor, as lines, blank ones dropped. */
const linesOn = (written: Written[], fd: 1 | 2): string[] =>
  written
    .filter((entry) => entry.fd === fd)
    .flatMap((entry) => entry.text.split('\n'))
    .filter((line) => line.trim() !== '');

/**
 * Type a script of lines into the session, one per `rl.question`, and record both descriptors for
 * the whole run. The last line must end the session or the loop never returns.
 */
const runSession = async (typed: string[]): Promise<Written[]> => {
  const queue = [...typed];
  rlQuestionMock.mockImplementation(async () => queue.shift() ?? 'exit');
  const { createInteractiveSession } = await import('#src/modules/interactiveSessionModule.js');
  return captureFds(async () => {
    await createInteractiveSession(sessionConfig, {});
  });
};

describe('interactiveSessionModule — [[EXT-165]] a command notice is written to ONE stream', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /**
   * The precondition every case here rests on. Asserted rather than assumed: on a terminal both
   * descriptors go to the same place and every claim below would be vacuous.
   */
  it('runs with stdout that is NOT a terminal', () => {
    expect(process.stdout.isTTY).toBeFalsy();
  });

  /**
   * CONTROL, and it is what stops the assertions below being ones that cannot fail: it proves the
   * harness sees BOTH descriptors, and it reproduces the exact split this node exists to close —
   * the title's colour picking its stream, so a title on stderr and its body on stdout.
   */
  it('CONTROL: the old title/body pairing still tears across both descriptors', async () => {
    const { display, displayWarning, displayInfo } = await import(
      '@gaunt-sloth/core/utils/consoleUtils.js'
    );
    const written = await captureFds(() => {
      displayWarning('warn-title-control');
      display('  body-control');
      displayInfo('info-title-control');
    });
    expect(linesOn(written, 1)).toEqual(['  body-control', 'info-title-control']);
    expect(linesOn(written, 2)).toEqual(['warn-title-control']);
  });

  /**
   * `/status` — the info tone, through the registry the Ink TUI shares. Its body carries the mode
   * and the turn count; a reader who kept only the title would have a heading and no status.
   */
  it('puts an INFO notice — title and every body line — on stderr and none of it on stdout', async () => {
    const written = await runSession(['/status', 'exit']);
    const err = linesOn(written, 2);
    const out = linesOn(written, 1);

    expect(err).toContain('Session status');
    expect(err.some((line) => line.startsWith('  Mode: code'))).toBe(true);
    expect(err.some((line) => line.startsWith('  Turns so far: 0'))).toBe(true);

    // Not one line of the notice on stdout — the half a redirect used to keep.
    expect(out).not.toContain('Session status');
    expect(out.some((line) => line.startsWith('  Mode: code'))).toBe(false);
    expect(out.some((line) => line.startsWith('  Turns so far:'))).toBe(false);
  });

  /**
   * `/mouse` — the warn tone, on a surface with no mouse layer. Same claim, and the tone must not
   * change the stream: that coupling of colour to stream is the defect itself.
   */
  it('puts a WARN notice — title and every body line — on stderr and none of it on stdout', async () => {
    const written = await runSession(['/mouse', 'exit']);
    const err = linesOn(written, 2);
    const out = linesOn(written, 1);

    // The title, marked as a warning in the TEXT: a pipe strips the colour, and severity that
    // exists only in the colour is severity a monochrome reader never receives.
    expect(err).toContain('⚠ Mouse unavailable');
    expect(err.some((line) => line.startsWith('  This session has no mouse layer'))).toBe(true);

    expect(out.some((line) => line.includes('Mouse unavailable'))).toBe(false);
    expect(out.some((line) => line.startsWith('  This session has no mouse layer'))).toBe(false);
  });

  /**
   * The two tones side by side, with the colour off: `warn` still reads as louder than `info`
   * because the marker is in the text. [[EXT-105]] made severity legible in words as well as
   * colour precisely so a monochrome reader is not left out, and this is that property for notices.
   */
  it('keeps a warn notice distinguishable from an info one with no colour at all', async () => {
    const written = await runSession(['/mouse', '/status', 'exit']);
    const err = linesOn(written, 2);
    const warnTitle = err.find((line) => line.includes('Mouse unavailable'));
    const infoTitle = err.find((line) => line.includes('Session status'));

    // No colour was applied at all — the harness is not a TTY, so this compares the plain text.
    expect(warnTitle).toBe('⚠ Mouse unavailable');
    expect(infoTitle).toBe('Session status');
    expect(warnTitle).not.toBe(infoTitle);
  });
});
