import { Command } from 'commander';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { GthConfig } from '@gaunt-sloth/core/config.js';
import { GTH_GH_READ_FILE_TOOL_NAME } from '@gaunt-sloth/review/tools/ghReadFileTool.js';

/**
 * CFG-54 — which pull request `gth_gh_read_file` actually reads.
 *
 * The tool's owner/repo/ref are resolved by shelling out to `gh pr view [<id>]`, so the id the
 * command hands the review module decides which pull request the reviewer reads FILES from, while
 * the content source decides which one it gets the DIFF from. Those are two separate wires between
 * the same two points, and when they disagree the review is silently conducted against a file tree
 * belonging to some other pull request — nothing errors, and the output looks ordinary.
 *
 * These cases join the two ends nobody else joins. `prCommand.spec.ts` asserts the argument against
 * a MOCKED review module; `ghReadFileTool.spec.ts` calls the tool factory directly; the review
 * module's own specs never pass a review context at all. Here commander parses the real argv, the
 * real review module injects the real tool, and the tool is INVOKED — so the assertion is on the
 * `gh` command line that a user's PR review would actually run.
 */

// `vi.hoisted` because this spec statically imports the tool-name constant, which pulls core's
// config module in at hoist time — before a plain top-level `const` would be initialised.
const {
  gthAgentRunnerInstanceMock,
  gthAgentRunnerMock,
  initConfigMock,
  consoleUtilsMock,
  llmUtilsMock,
  resolversMock,
  execAsyncMock,
  ghPrDiffGetMock,
  fileSourceGetMock,
} = vi.hoisted(() => {
  const runnerInstance = {
    init: vi.fn(),
    processMessages: vi.fn(),
    cleanup: vi.fn(),
  };
  return {
    gthAgentRunnerInstanceMock: runnerInstance,
    gthAgentRunnerMock: vi.fn(function GthAgentRunnerMock() {
      return runnerInstance;
    }),
    initConfigMock: vi.fn(),
    consoleUtilsMock: {
      display: vi.fn(),
      displayError: vi.fn(),
      displayInfo: vi.fn(),
      displayWarning: vi.fn(),
      displaySuccess: vi.fn(),
      displayDebug: vi.fn(),
      defaultStatusCallback: vi.fn(),
      initSessionLogging: vi.fn(),
      flushSessionLog: vi.fn(),
      stopSessionLogging: vi.fn(),
    },
    llmUtilsMock: {
      readBackstory: vi.fn(),
      readGuidelines: vi.fn(),
      readReviewInstructions: vi.fn(),
      readSystemPrompt: vi.fn(),
    },
    resolversMock: { createResolvers: vi.fn() },
    execAsyncMock: vi.fn(),
    ghPrDiffGetMock: vi.fn(),
    fileSourceGetMock: vi.fn(),
  };
});

vi.mock('@gaunt-sloth/core/core/GthAgentRunner.js', () => ({
  GthAgentRunner: gthAgentRunnerMock,
}));

// PARTIAL mocks throughout: the review module and the tool factory resolve the built-in tool
// registry and the byte cap through the real config module, and these cases assert what the real
// injection does, so only the named exports are replaced.
vi.mock('@gaunt-sloth/core/config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@gaunt-sloth/core/config.js')>()),
  initConfig: initConfigMock,
}));

vi.mock('@gaunt-sloth/core/utils/consoleUtils.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@gaunt-sloth/core/utils/consoleUtils.js')>()),
  ...consoleUtilsMock,
}));

vi.mock('@gaunt-sloth/core/utils/llmUtils.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@gaunt-sloth/core/utils/llmUtils.js')>()),
  ...llmUtilsMock,
}));

// The tool shells out through this module; the whole point of these cases is the command string
// it is handed, and no case may reach the machine's real `gh`.
vi.mock('@gaunt-sloth/core/utils/systemUtils.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@gaunt-sloth/core/utils/systemUtils.js')>()),
  execAsync: execAsyncMock,
}));

vi.mock('@gaunt-sloth/agent/resolvers.js', () => resolversMock);

// Content/requirement sources are reached through a dynamic import of the path in
// CONTENT_SOURCES / REQUIREMENTS_SOURCES; mock them so no case shells out to `gh`.
vi.mock('@gaunt-sloth/review/sources/ghPrDiffSource.js', () => ({ get: ghPrDiffGetMock }));
vi.mock('@gaunt-sloth/review/sources/fileSource.js', () => ({ get: fileSourceGetMock }));

const PR_VIEW_JSON = JSON.stringify({
  headRefName: 'feature-branch',
  headRepository: { name: 'hello-world' },
  headRepositoryOwner: { login: 'octocat' },
});

const CONTENTS_JSON = JSON.stringify({
  type: 'file',
  encoding: 'base64',
  path: 'a.txt',
  content: Buffer.from('hello world', 'utf8').toString('base64'),
});

/**
 * A resolved config with the GitHub content source everywhere it matters, so every case in this
 * file differs from its neighbours ONLY in the argv it drives. `output.header: 'none'` and
 * `streamOutput` keep the run silent and free of the progress indicator's interval;
 * `writeOutputToFile: false` keeps it off the disk.
 *
 * Built FRESH per run on purpose: the injector appends into `config.tools` in place and dedupes by
 * tool name, and the tool memoises its resolved PR context in a closure — so a config shared
 * between two runs would hand the second run the first run's tool, with the first run's id already
 * baked in, and every case in a pair would agree for the wrong reason.
 */
function resolvedConfig(): GthConfig {
  return {
    llm: {} as BaseChatModel,
    contentSource: 'github',
    requirementSource: 'file',
    streamOutput: true,
    writeOutputToFile: false,
    useColour: false,
    filesystem: 'none',
    streamSessionInferenceLog: false,
    canInterruptInferenceWithEsc: false,
    includeCurrentDateAfterGuidelines: false,
    output: { header: 'none' },
    commands: {
      review: { contentSource: 'github', requirementSource: 'file' },
      pr: { contentSource: 'github', requirementSource: 'file' },
    },
  } as unknown as GthConfig;
}

/**
 * Drive one real command through commander and INVOKE the `gth_gh_read_file` tool the review
 * module injected, returning the `gh pr view …` command line the tool resolved its PR with.
 */
async function ghPrViewCommandFor(argv: string[]): Promise<string> {
  initConfigMock.mockResolvedValue(resolvedConfig());
  execAsyncMock.mockClear();

  const program = new Command();
  if (argv[0] === 'review') {
    const { reviewCommand } = await import('#src/commands/reviewCommand.js');
    reviewCommand(program, {});
  } else {
    const { prCommand } = await import('#src/commands/prCommand.js');
    prCommand(program, {});
  }
  await program.parseAsync(['na', 'na', ...argv]);

  expect(gthAgentRunnerInstanceMock.init).toHaveBeenCalled();
  const config = gthAgentRunnerInstanceMock.init.mock.calls.at(-1)?.[1] as GthConfig;
  const injected = (config.tools ?? []).find(
    (t) =>
      typeof t === 'object' && t !== null && 'name' in t && t.name === GTH_GH_READ_FILE_TOOL_NAME
  ) as unknown as { invoke: (args: { path: string }) => Promise<string> } | undefined;
  expect(injected, 'the gh read-file tool was not injected at all').toBeDefined();

  await injected!.invoke({ path: 'a.txt' });

  const prViewCall = execAsyncMock.mock.calls
    .map(([command]) => String(command))
    .find((command) => command.startsWith('gh pr view'));
  expect(prViewCall, 'the tool never resolved a pull request via gh pr view').toBeDefined();
  return prViewCall as string;
}

const PR_VIEW = (selector: string) =>
  `gh pr view${selector} --json headRefName,headRepository,headRepositoryOwner`;

describe('CFG-54 the pull request the gh read-file tool is bound to', () => {
  beforeEach(() => {
    vi.resetAllMocks();

    gthAgentRunnerMock.mockImplementation(function () {
      return gthAgentRunnerInstanceMock;
    });
    gthAgentRunnerInstanceMock.init.mockResolvedValue(undefined);
    gthAgentRunnerInstanceMock.processMessages.mockResolvedValue('REVIEW');
    gthAgentRunnerInstanceMock.cleanup.mockResolvedValue(undefined);

    llmUtilsMock.readBackstory.mockReturnValue('BACKSTORY');
    llmUtilsMock.readGuidelines.mockReturnValue('GUIDELINES');
    llmUtilsMock.readReviewInstructions.mockReturnValue('REVIEW INSTRUCTIONS');
    llmUtilsMock.readSystemPrompt.mockReturnValue('');

    resolversMock.createResolvers.mockReturnValue({
      resolveMiddleware: vi.fn(async (m: unknown) => m ?? []),
    });

    execAsyncMock.mockImplementation(async (command: string) =>
      command.startsWith('gh pr view') ? PR_VIEW_JSON : CONTENTS_JSON
    );
    ghPrDiffGetMock.mockResolvedValue('GITHUB PR DIFF');
    fileSourceGetMock.mockResolvedValue('');
  });

  it('reads files from the pull request named on a `gth review <id>`', async () => {
    // The defect: the diff came from PR 42 and the files came from whatever PR the current branch
    // happens to have — a review of one pull request against another one's file tree.
    expect(await ghPrViewCommandFor(['review', '42', '--content-source', 'github'])).toBe(
      PR_VIEW(' 42')
    );

    // BOTH ends of the divergence, not just the one that was broken. The invariant is that the two
    // wires name the SAME pull request, so asserting only the tool's end would let the mirror-image
    // defect — the diff drifting to a different id while the tool stays right — pass in silence.
    expect(
      ghPrDiffGetMock.mock.calls.at(-1)?.[1],
      'the diff was fetched for a different pull request than the files'
    ).toBe('42');
  });

  it('still discovers the pull request from the branch when `gth review` is given no id', async () => {
    // The control, and the behaviour that must survive the fix: with nothing to address, the tool
    // falls back to `gh pr view` with no selector, which resolves the current branch's PR.
    expect(await ghPrViewCommandFor(['review', '--content-source', 'github'])).toBe(PR_VIEW(''));
  });

  it('falls back to branch discovery when the review argument is not a pull request id', async () => {
    // `gth review`'s positional is a CONTENT id, not a PR id: with the github content source it is
    // a PR number, but the same argument is a ref range or a file path under another source, and a
    // user can leave a github source configured while passing one. Forwarding it verbatim would
    // hand the tool an id `gh pr view` cannot address, and the tool would refuse rather than fall
    // back — so the id is filtered to a bare number and anything else means "discover".
    expect(await ghPrViewCommandFor(['review', 'origin/main...HEAD'])).toBe(PR_VIEW(''));
  });

  it('reads files from the pull request named on a `gth pr <id>`', async () => {
    // `gth pr` passes its own review context, and until now nothing tested that end to end: its
    // spec asserts the argument against a mocked review module, so the seam from that argument to
    // this `gh` command line was covered by no test in the repo. A change to the shared review
    // context could break `gth pr` — the command this tool was built for — with nothing going red.
    expect(await ghPrViewCommandFor(['pr', '42'])).toBe(PR_VIEW(' 42'));
  });
});
