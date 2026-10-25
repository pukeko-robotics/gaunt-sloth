import { Command } from 'commander';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { GthConfig } from '@gaunt-sloth/core/config.js';
import { GTH_GH_READ_FILE_DIFF_TOOL_NAME } from '@gaunt-sloth/review/tools/ghReadFileDiffTool.js';

/**
 * REL-6 — `gth pr` and `gth review --content-source github` give the review agent the per-file diff
 * tool on a large PR, and only then.
 *
 * The one seam no other spec joins: the github source reports its triage through the
 * `onLargePr` callback the COMMAND passed it, and the command hands that value to the real review
 * module, which registers the real tool. The source is mocked at its module boundary, so each case
 * scripts whether the triage named files; everything from the command to the tool is real, and the
 * tool is invoked.
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

const LISTING = {
  binding: { host: 'github.com', owner: 'o', repo: 'r', number: '42' },
  entries: [
    {
      path: 'tests/baselines/reference/a(target=es2015).js',
      status: 'added' as const,
      additions: 1,
      deletions: 0,
      patch: '@@ -0,0 +1 @@\n+export {};',
    },
  ],
  elidedCount: 1,
};

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

type Invocable = { name: string; invoke: (args: { path: string }) => Promise<string> };

/** Drive one real command and return the diff tool the review module registered, if any. */
async function diffToolFor(argv: string[]): Promise<Invocable | undefined> {
  initConfigMock.mockResolvedValue(resolvedConfig());
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
  return ((config.tools ?? []) as unknown as Invocable[]).find(
    (t) => typeof t === 'object' && t !== null && t.name === GTH_GH_READ_FILE_DIFF_TOOL_NAME
  );
}

describe('REL-6 the per-file diff tool on gth pr and gth review', () => {
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
    // No case may reach the machine's real `gh`.
    execAsyncMock.mockRejectedValue(new Error('no gh in this spec'));
    fileSourceGetMock.mockResolvedValue('');
  });

  const largeSource = async (
    _config: unknown,
    _id: string | undefined,
    context?: { onLargePr?: (listing: typeof LISTING) => void; command?: string }
  ) => {
    context?.onLargePr?.(LISTING);
    return 'TRIAGED LARGE PR';
  };

  for (const argv of [
    ['pr', '42'],
    ['review', '42', '--content-source', 'github'],
  ]) {
    it(`registers it on a large PR and serves the listing, for gth ${argv.join(' ')}`, async () => {
      ghPrDiffGetMock.mockImplementation(largeSource);
      const tool = await diffToolFor(argv);
      expect(tool, 'the diff tool was not registered').toBeDefined();
      expect(
        await tool!.invoke({ path: 'tests/baselines/reference/a(target=es2015).js' })
      ).toContain('+export {};');
      // Served from the listing the source already fetched: no `gh` call at all.
      expect(execAsyncMock).not.toHaveBeenCalled();
      // The source was told which command's registry to read.
      expect(ghPrDiffGetMock.mock.calls.at(-1)?.[2]).toMatchObject({ command: argv[0] });
    });

    it(`registers nothing on a PR that fits, for gth ${argv.join(' ')}`, async () => {
      ghPrDiffGetMock.mockResolvedValue('SMALL PR DIFF');
      expect(await diffToolFor(argv)).toBeUndefined();
    });
  }
});
