import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionConfig } from '#src/modules/interactiveSessionModule.js';
import type {
  GthAgentInterface,
  GthConfig,
  PendingToolInterrupt,
} from '@gaunt-sloth/core/core/types.js';

/**
 * [[EXT-154]] — **the readline surface's remembering answers, against a store that could not receive
 * them.**
 *
 * The cases in `interactiveSessionApprovalMenu.spec.ts` hand the surface a lifetime and assert the
 * sentence; they prove the derivation and nothing about where the value comes from. This file makes
 * nobody say it. A real {@link GthAgentRunner} with the real approvals gate answers a real `[d]`,
 * tries to write a real deny file, and the line on the terminal is whatever came back — the only
 * version of the assertion a hand-fed lifetime cannot pass by construction.
 *
 * **The fixture is a project directory that does not exist**, the technique [[EXT-149]] measured and
 * for its reason: with no `.gsloth` dir the store's write path resolves straight into the project
 * dir with no `mkdir` on the way, so the LOAD succeeds and the write then fails with ENOENT on
 * Linux, macOS and Windows alike. **`chmod` would not do** — it is a no-op on win32, so a case built
 * on it would pass vacuously on both Windows cells and prove nothing there.
 *
 * **Both halves, because one alone cannot fail for the right reason.** The two runs differ in
 * exactly one thing — whether the deny file could be written — so the unwritable half alone would
 * pass against a build that had dropped the saved wording entirely, and the writable half alone
 * against one that never had the session wording.
 *
 * ## What is mocked, and what deliberately is not
 *
 * Only the terminal and the model are replaced: readline's `question`, the console writers, and the
 * agent behind the runner. `GthAgentRunner`, the gate, the entry grammar and the persisted deny
 * store are all the real thing — which is what makes a run here evidence about the seam rather than
 * about a stub's return value. `systemUtils` and `fileUtils` are therefore PARTIAL mocks: the
 * project-dir anchor the store resolves from lives in the first and must stay real for
 * `setProjectDir` to move it.
 */

// ── the terminal ──────────────────────────────────────────────────────────────
/** Answers for the main `  > ` prompt, in order. */
const mainAnswers: string[] = [];
/** Answers for the approval dialog's own (empty-prompt) question, in order. */
const approvalAnswers: string[] = [];
const rlQuestionMock = vi.fn(async (prompt: string) => {
  // [[EXT-105]] — the menu is written as a dialog line and readline is handed an EMPTY prompt, so
  // the two questions are told apart by which one carries the `>`.
  if (typeof prompt === 'string' && prompt.includes('>')) return mainAnswers.shift() ?? 'exit';
  return approvalAnswers.shift() ?? '';
});
vi.mock('@gaunt-sloth/core/utils/systemUtils.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@gaunt-sloth/core/utils/systemUtils.js')>()),
  createInterface: vi.fn(() => ({ question: rlQuestionMock, close: vi.fn() })),
  setRawMode: vi.fn(),
  refStdin: vi.fn(),
  getUseColour: vi.fn(() => false),
  exit: vi.fn(),
  stdin: { isTTY: true },
  stdout: { isTTY: true, columns: 120 },
}));

const displayDialogLineMock = vi.fn();
vi.mock('@gaunt-sloth/core/utils/consoleUtils.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@gaunt-sloth/core/utils/consoleUtils.js')>()),
  display: vi.fn(),
  displayInfo: vi.fn(),
  displayWarning: vi.fn(),
  displayError: vi.fn(),
  displaySuccess: vi.fn(),
  displayLaunchBanner: vi.fn(),
  displayDialogLine: displayDialogLineMock,
  formatInputPrompt: vi.fn((v: string) => v),
}));

// ── the model ─────────────────────────────────────────────────────────────────
/** The command every case here is asked about. Statically resolvable, so a deny entry can form. */
const COMMAND = 'npm publish';

/**
 * An agent that suspends once on a gated `run_shell_command`, then finishes.
 *
 * Only the four methods the readline turn actually drives are implemented: `processMessages` takes
 * the non-streaming branch (`invoke`), and its interrupt drain needs `getPendingToolInterrupts` and
 * `streamResume`. A fresh instance per run, so the one-shot suspension cannot leak between cases.
 */
function suspendingAgent(): GthAgentInterface {
  let suspended = false;
  return {
    async init() {},
    async invoke() {
      suspended = true;
      return '';
    },
    async stream() {
      throw new Error('not used: these cases run with streamOutput off');
    },
    async *streamWithEvents() {},
    async *streamWithEventsResume() {},
    async getPendingToolInterrupts(): Promise<PendingToolInterrupt[]> {
      if (!suspended) return [];
      suspended = false;
      return [{ name: 'run_shell_command', args: { command: COMMAND } }];
    },
    async streamResume() {
      return (async function* () {
        yield 'Left it alone.';
      })() as never;
    },
    async cleanup() {},
  } as unknown as GthAgentInterface;
}

const CONFIG = {
  streamOutput: false,
  streamSessionInferenceLog: false,
  useColour: false,
  writeOutputToFile: false,
  modelDisplayName: 'test-model',
  llm: { _llmType: () => 'test', verbose: false },
  // The shell gate on, allow-list and rater off, so the command escalates straight to the human.
  approvals: { mode: 'ask', allowlist: false },
  commands: { code: { builtInTools: { run_shell_command: { enabled: true } } } },
} as unknown as GthConfig;

vi.mock('@gaunt-sloth/core/config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@gaunt-sloth/core/config.js')>()),
  initConfig: vi.fn(async () => CONFIG),
}));
vi.mock('@gaunt-sloth/core/utils/fileUtils.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@gaunt-sloth/core/utils/fileUtils.js')>()),
  // null ⇒ the session-logging branch is skipped; the real writer would create files beside the
  // project dir this suite is deliberately pointing at a path that does not exist.
  getCommandOutputFilePath: vi.fn(() => null),
}));
vi.mock('#src/resolvers.js', () => ({ createResolvers: vi.fn(() => ({})) }));

const sessionConfig = {
  mode: 'code',
  readModePrompt: () => null,
  description: 'code',
  readyMessage: 'ready',
  exitMessage: 'exit hint',
} as unknown as SessionConfig;

describe('[[EXT-154]] the readline confirmation is written from what the runner recorded', () => {
  /** The store anchors here, so a case driving a gated call must clamp it. */
  const tmpRoot = mkdtempSync(join(tmpdir(), 'gth-ext154-readline-'));
  /** Never created, and nothing on the way to the store's path creates it. */
  const unwritableDir = join(tmpRoot, 'no-such-checkout');
  /**
   * The writable dir for the APPROVE control, deliberately not the one the refusal control uses.
   *
   * A refusal that lands writes an exact entry for {@link COMMAND} into that dir's deny file, and
   * the deny store is consulted at every rung — so an approve case pointed at the same dir would be
   * refused before anyone was asked, and would fail as a missing confirmation rather than as the
   * contamination it is. Nesting is safe because both stores resolve through
   * `getGslothConfigWritePath`, which joins onto the project dir and never walks up.
   */
  const approveRoot = join(tmpRoot, 'approve-ok');
  mkdirSync(approveRoot, { recursive: true });
  let priorProjectDir: string | undefined;

  beforeEach(async () => {
    mainAnswers.length = 0;
    approvalAnswers.length = 0;
    displayDialogLineMock.mockClear();
    const { peekProjectDir } = await import('@gaunt-sloth/core/utils/systemUtils.js');
    priorProjectDir = peekProjectDir();
  });

  afterEach(async () => {
    const { setProjectDir } = await import('@gaunt-sloth/core/utils/systemUtils.js');
    setProjectDir(priorProjectDir);
  });

  afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }));

  /**
   * Run one whole session: a prompt, the gated call it produces, `key` at the approval dialog, then
   * `exit`. Returns the dialog lines the session wrote, in order.
   */
  const sessionAnswering = async (key: string, projectDir: string): Promise<string[]> => {
    const { setProjectDir } = await import('@gaunt-sloth/core/utils/systemUtils.js');
    setProjectDir(projectDir);
    const agent = suspendingAgent();
    vi.doMock('#src/core/resolveAgentFactory.js', () => ({
      resolveAgentFactory: vi.fn(() => () => agent),
    }));
    mainAnswers.push('publish it', 'exit');
    approvalAnswers.push(key);
    const { createInteractiveSession } = await import('#src/modules/interactiveSessionModule.js');
    await createInteractiveSession(sessionConfig, {});
    return displayDialogLineMock.mock.calls.flatMap((call: unknown[]) =>
      String(call[0]).split('\n')
    );
  };

  /**
   * The ONE confirmation the remembering answer produced, or `''` when it produced none.
   *
   * Scoped to that line rather than swept over the session's output, because the phrases these
   * cases turn on are not this line's alone — the menu above it names the project file too, and a
   * `toContain` over everything the dialog wrote would be answered by the label rather than by the
   * confirmation, and would go on being answered by it with the confirmation deleted.
   *
   * Both openers, because both remembering answers are driven below. `Approve?` — the menu's own
   * row — does not match `Approved`, so widening it does not widen what this can pick up.
   */
  const confirmation = (lines: string[]): string =>
    lines.find((line) => line.startsWith('Refused —') || line.startsWith('Approved')) ?? '';

  it('a deny file that cannot be written gets the session sentence, and makes no project claim', async () => {
    const lines = await sessionAnswering('d', unwritableDir);
    const said = confirmation(lines);

    // Committed at all — asserted before anything is looked for inside it, because a "does not
    // claim persistence" test passes just as happily when nothing was written at all.
    expect(said).not.toBe('');
    expect(said).toContain('will not ask again this session');
    expect(said).toContain('a new session will ask about it again');
    expect(said).not.toContain('saved to this project');
    expect(said).not.toContain('stays refused in new sessions');

    // …and the surface agrees with the disk it was describing. Nothing reached it.
    expect(existsSync(unwritableDir)).toBe(false);
  });

  it('CONTROL — with a writable project dir the same keystroke says saved to this project', async () => {
    const lines = await sessionAnswering('d', tmpRoot);
    const said = confirmation(lines);

    expect(said).toContain('It is saved to this project');
    expect(said).toContain('stays refused in new sessions');
    expect(said).not.toContain('a new session will ask about it again');

    // The file the sentence claims, on disk.
    expect(existsSync(join(tmpRoot, 'shell-denylist.json'))).toBe(true);
  });

  /**
   * The same pair for `[a]`, and not a formality: the two answers are separate branches of the
   * copy, so a refusal that reads correctly says nothing about what an approval claims. Without
   * these, the approve-and-not-saved sentence is a branch no case ever produces, and swapping it
   * for either of its neighbours goes unnoticed.
   */
  it('an allow-list that cannot be written gets the session sentence, and makes no project claim', async () => {
    const lines = await sessionAnswering('a', unwritableDir);
    const said = confirmation(lines);

    expect(said).not.toBe('');
    expect(said).toContain('Approved for this session only');
    expect(said).toContain('not written to the project allow-list');
    expect(said).not.toContain('Approved and remembered');

    expect(existsSync(unwritableDir)).toBe(false);
  });

  it('CONTROL — with a writable project dir the same keystroke says saved to the project', async () => {
    const lines = await sessionAnswering('a', approveRoot);
    const said = confirmation(lines);

    expect(said).toContain('Approved and remembered');
    expect(said).toContain('saved to the project allow-list');
    expect(said).not.toContain('for this session only');

    // The file the sentence claims, on disk. This is also what proves `[a]` was on offer at all —
    // an unoffered option reads as an empty confirmation, which names nothing about the cause.
    expect(existsSync(join(approveRoot, 'shell-allowlist.json'))).toBe(true);
  });
});
