/**
 * REL-6 Part A — **what compaction does inside a large-PR review, measured on the real path.**
 *
 * The real `review()`, the real `GthAgentRunner` and lean agent (so the real EXT-160/161 context
 * guard), the real review-rate middleware and the real `gth_gh_read_file_diff` tool, on a scripted
 * model that serves the review, the compaction summariser and the rating call, and records each.
 * The content is the real triage of a synthetic listing, so the first human message carries the
 * REL-21 manifest and the REL-6 framing exactly as a run would.
 *
 * These cells PIN the behaviour as it stands; they are measurements, not endorsements. Two of them
 * pin a gap that is still open (the manifest is folded away, and the summariser is not asked to
 * keep it). The "unsized reads" Q2 cell pins the core guard sending a call it cannot fold, on reads
 * sized to the unknown-window fallback. The cells marked "fixed" and the acceptance run pin the
 * opposite: with reads sized from the listing's budget and the rating basis bounded, no review
 * request and no rating request passes the threshold.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { GthConfig } from '@gaunt-sloth/core/config.js';
import { deleteArtifact } from '@gaunt-sloth/core/state/artifactStore.js';
import { displaySuccess } from '@gaunt-sloth/core/utils/consoleUtils.js';
import { isCompactionSummary } from '@gaunt-sloth/core/core/compaction.js';
import { estimatePromptTokens } from '@gaunt-sloth/core/core/GthLangChainAgent.js';
import { REVIEW_RATE_ARTIFACT_KEY } from '#src/middleware/reviewRateMiddleware.js';
import { diffBudgetBytes, triagePrFiles } from '#src/utils/prDiffTriage.js';
import type { PrFileEntry } from '#src/utils/prFilesListing.js';

vi.mock('@gaunt-sloth/core/utils/llmUtils.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@gaunt-sloth/core/utils/llmUtils.js')>();
  return {
    ...actual,
    buildSystemMessages: vi.fn(() => [{ content: 'SYSTEM PROMPT' }]),
    readModePrompt: vi.fn(() => 'review-mode-prompt'),
  };
});

vi.mock('@gaunt-sloth/core/utils/consoleUtils.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@gaunt-sloth/core/utils/consoleUtils.js')>();
  return {
    ...actual,
    display: vi.fn(),
    displayInfo: vi.fn(),
    displayWarning: vi.fn(),
    displayError: vi.fn(),
    displaySuccess: vi.fn(),
    displayDebug: vi.fn(),
    displayToolIndication: vi.fn(),
    defaultStatusCallback: vi.fn(),
    initSessionLogging: vi.fn(),
    flushSessionLog: vi.fn(),
    stopSessionLogging: vi.fn(),
  };
});

// No case may reach the machine's `gh`, and a verdict must not set this process's exit code.
const { execAsyncMock } = vi.hoisted(() => ({
  execAsyncMock: vi.fn(async (_command: string): Promise<string> => {
    throw new Error('no gh in this spec');
  }),
}));
vi.mock('@gaunt-sloth/core/utils/systemUtils.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@gaunt-sloth/core/utils/systemUtils.js')>()),
  execAsync: execAsyncMock,
  setExitCode: vi.fn(),
}));

const RATE_TOOL = 'gth_review_rate';
const DIFF_TOOL = 'gth_gh_read_file_diff';
const MANIFEST_MARKER = 'Files not shown in full';

/** 30 files; every patch is big enough that only a few fit the triage budget. */
const ENTRIES: PrFileEntry[] = Array.from({ length: 30 }, (_, i) => ({
  path: `src/module${String(i).padStart(2, '0')}/index(${i}).ts`,
  status: 'modified',
  additions: 200,
  deletions: 0,
  patch: `@@ -0,0 +1,200 @@\n${`+line of module ${i}\n`.repeat(400)}`,
}));
const BINDING = { host: 'github.com', owner: 'o', repo: 'r', number: '7' };

const TRIAGE_BUDGET_BYTES = 12_000;

function largePrContent(budgetBytes = TRIAGE_BUDGET_BYTES): { content: string; elided: number } {
  const result = triagePrFiles(ENTRIES, {
    budgetBytes,
    prLabel: '#7',
    readFileToolEnabled: true,
    fileDiffToolEnabled: true,
    route: 'too-many-files',
  });
  return { content: result.content, elided: result.elided.length };
}

const text = (message: BaseMessage): string =>
  typeof message.content === 'string' ? message.content : JSON.stringify(message.content);

/**
 * Reads `reads` elided files through the diff tool, one per turn, then writes the review. The
 * last read asks for a path the way a model might after its manifest was folded away (base name
 * only), which the tool must answer with close matches rather than a bare refusal.
 */
class ScriptedLargePrModel extends BaseChatModel {
  readonly reviewCalls: BaseMessage[][] = [];
  readonly summaryPrompts: string[] = [];
  readonly ratingCalls: BaseMessage[][] = [];
  readonly toolResults: string[] = [];
  constructor(
    private readonly paths: Array<string | { pattern: string }>,
    private readonly finalReview: string,
    private readonly window?: number
  ) {
    super({});
  }
  get profile(): { maxInputTokens?: number } {
    return this.window === undefined ? {} : { maxInputTokens: this.window };
  }
  _llmType(): string {
    return 'scripted-large-pr';
  }
  bindTools(): unknown {
    return this;
  }
  async _generate(messages: BaseMessage[]) {
    const last = messages[messages.length - 1];
    if (HumanMessage.isInstance(last) && text(last).startsWith('<role>')) {
      this.summaryPrompts.push(text(last));
      return {
        generations: [{ message: new AIMessage('SUMMARY OF THE REVIEW SO FAR'), text: '' }],
      };
    }
    if (HumanMessage.isInstance(last) && text(last).includes(RATE_TOOL)) {
      this.ratingCalls.push([...messages]);
      const message = new AIMessage({
        content: '',
        tool_calls: [{ name: RATE_TOOL, args: { rate: 7, comment: 'scored' }, id: 'rate-1' }],
      });
      return { generations: [{ message, text: '' }] };
    }
    if (ToolMessage.isInstance(last)) this.toolResults.push(text(last));
    this.reviewCalls.push([...messages]);
    const turn = this.reviewCalls.length;
    const step = this.paths[turn - 1];
    const message =
      turn <= this.paths.length
        ? new AIMessage({
            content: '',
            tool_calls: [
              {
                name: DIFF_TOOL,
                args: typeof step === 'string' ? { path: step } : { pattern: step.pattern },
                id: `read-${turn}`,
              },
            ],
          })
        : new AIMessage(this.finalReview);
    return { generations: [{ message, text: '' }] };
  }
}

function configFor(model: ScriptedLargePrModel, extra: Record<string, unknown> = {}): GthConfig {
  return {
    llm: model,
    contentSource: 'github',
    requirementSource: 'file',
    streamOutput: false,
    writeOutputToFile: false,
    useColour: false,
    filesystem: 'none',
    streamSessionInferenceLog: false,
    canInterruptInferenceWithEsc: false,
    includeCurrentDateAfterGuidelines: false,
    output: { header: 'none' },
    commands: {
      pr: { contentSource: 'github', rating: { enabled: true } },
      review: { contentSource: 'github', rating: { enabled: true } },
    },
    ...extra,
  } as unknown as GthConfig;
}

/**
 * Run the real `review()` on the large-PR fixture. `budgetBytes` is the triage budget the source
 * would hand over in `LargePrListing`; left out, the listing carries none, as it did before the
 * diff tool sized its answers from it, and the tool falls back to the unknown-window budget.
 */
async function runReview(
  command: 'pr' | 'review',
  model: ScriptedLargePrModel,
  extra: Record<string, unknown> = {},
  budgetBytes?: number
): Promise<{ content: string }> {
  const { content, elided } = largePrContent(budgetBytes ?? TRIAGE_BUDGET_BYTES);
  const { review } = await import('#src/modules/reviewModule.js');
  await review('PR-7', '', content, configFor(model, extra), command, undefined, {
    prId: '7',
    largePr: {
      binding: BINDING,
      entries: ENTRIES,
      elidedCount: elided,
      ...(budgetBytes === undefined ? {} : { budgetBytes }),
    },
  });
  return { content };
}

/** Elided paths, in listing order, as the model would pick them off the manifest. */
const elidedPaths = (budgetBytes = TRIAGE_BUDGET_BYTES): string[] => {
  const { content } = largePrContent(budgetBytes);
  return ENTRIES.map((e) => e.path).filter((p) => !content.includes(`+++ b/${p}`));
};

describe('REL-6 Part A — compaction inside a large-PR review', () => {
  beforeEach(() => {
    vi.mocked(displaySuccess).mockClear();
    deleteArtifact(REVIEW_RATE_ARTIFACT_KEY);
  });
  afterEach(() => deleteArtifact(REVIEW_RATE_ARTIFACT_KEY));

  it('the fixture is a large PR: most files are named only, and the framing names the diff tool', () => {
    const { content, elided } = largePrContent();
    expect(elided).toBeGreaterThan(20);
    expect(content).toContain(MANIFEST_MARKER);
    expect(content).toContain('very large');
  });

  // Q1 — the guard is installed for every command; review and pr are not exempt.
  for (const command of ['pr', 'review'] as const) {
    it(`Q1: an absolute autocompact threshold fires inside \`${command}\``, async () => {
      const paths = elidedPaths().slice(0, 4);
      const model = new ScriptedLargePrModel(paths, 'FINAL REVIEW');
      await runReview(command, model, { autocompact: 6000 });

      expect(model.summaryPrompts.length).toBeGreaterThanOrEqual(1);
      expect(model.reviewCalls).toHaveLength(paths.length + 1);
      // Every read was served from the run's listing: no `gh` call happened.
      expect(execAsyncMock).not.toHaveBeenCalled();
      // One verdict, scored.
      expect(model.ratingCalls).toHaveLength(1);
      expect(displaySuccess).toHaveBeenCalledWith(expect.stringContaining('PASS 7/10'));
    });
  }

  it('Q1: with no autocompact key the default threshold fires when the window is known, and nothing fires when it is not', async () => {
    const paths = elidedPaths().slice(0, 4);
    const known = new ScriptedLargePrModel(paths, 'FINAL REVIEW', 8000);
    await runReview('pr', known);
    expect(known.summaryPrompts.length).toBeGreaterThanOrEqual(1);

    // The control: the same run on a model whose window nothing knows.
    const unknown = new ScriptedLargePrModel(paths, 'FINAL REVIEW');
    await runReview('pr', unknown);
    expect(unknown.summaryPrompts).toEqual([]);
    expect(unknown.reviewCalls).toHaveLength(paths.length + 1);
  });

  it('Q2: the first human message (diff and manifest) is folded, and the summary is all that survives of it', async () => {
    const paths = elidedPaths().slice(0, 4);
    const model = new ScriptedLargePrModel(paths, 'FINAL REVIEW');
    const { content } = await runReview('pr', model, { autocompact: 6000 });

    // The first fold took the first message: the whole manifest went to the summariser.
    expect(model.summaryPrompts[0]).toContain(MANIFEST_MARKER);
    expect(model.summaryPrompts[0]).toContain(paths[3]);
    // The summariser's instructions (everything before the rendered messages) say nothing about
    // the manifest or the paths that can still be fetched; keeping them is left to the model.
    const instructions = model.summaryPrompts[0].slice(
      0,
      model.summaryPrompts[0].indexOf('<messages>')
    );
    expect(instructions).not.toMatch(/manifest|not shown|fetch|gth_gh_read_file/i);

    // After the fold, the next review request no longer carries the first message.
    const firstFolded = model.reviewCalls.findIndex((request) =>
      request.some((m) => isCompactionSummary(m))
    );
    expect(firstFolded).toBeGreaterThan(0);
    const after = model.reviewCalls[firstFolded];
    expect(after.some((m) => text(m) === content)).toBe(false);
    expect(after.some((m) => text(m).includes(MANIFEST_MARKER))).toBe(false);
    // What is left of it is the summary text, verbatim.
    expect(text(after.find((m) => isCompactionSummary(m))!)).toContain(
      'SUMMARY OF THE REVIEW SO FAR'
    );
  });

  it('Q2 (task 1 measurement, unsized reads): nothing can fold until three tool rounds follow the first message, so the guard lets calls past its threshold', async () => {
    // The listing carries no budget here, so the reads are sized to the unknown-window fallback,
    // far above what this 6000-token threshold can hold. Kept as the measurement the sizing fixes.
    const paths = elidedPaths().slice(0, 4);
    const model = new ScriptedLargePrModel(paths, 'FINAL REVIEW');
    await runReview('pr', model, { autocompact: 6000 });

    const hasSummary = (request: BaseMessage[]) => request.some((m) => isCompactionSummary(m));
    // The third call is already past the threshold, but the conversation is the first message and
    // two tool rounds — no more than the six messages compaction keeps verbatim — so it is sent
    // as it is (the guard's `changed: false` bail).
    expect(estimatePromptTokens(model.reviewCalls[2])).toBeGreaterThan(6000);
    expect(hasSummary(model.reviewCalls[2])).toBe(false);
    // The fourth is the first that can fold, and what it folds is the first message alone.
    expect(hasSummary(model.reviewCalls[3])).toBe(true);
    expect(model.summaryPrompts[0]).toContain(MANIFEST_MARKER);
    expect(model.summaryPrompts[0]).not.toContain('Diff of src/');
    expect(model.summaryPrompts[1]).toContain('Diff of src/');
    expect(estimatePromptTokens(model.reviewCalls[3])).toBeGreaterThan(6000);
  });

  it('Q2 (fixed): with the reads sized from the budget the listing hands over, no review call passes the threshold', async () => {
    const paths = elidedPaths().slice(0, 4);
    const model = new ScriptedLargePrModel(paths, 'FINAL REVIEW');
    await runReview('pr', model, { autocompact: 6000 }, TRIAGE_BUDGET_BYTES);

    expect(model.reviewCalls).toHaveLength(paths.length + 1);
    for (const request of model.reviewCalls) {
      expect(estimatePromptTokens(request)).toBeLessThanOrEqual(6000);
    }
    // The reads were cut to fit, and say so.
    expect(model.toolResults[0]).toContain("cut to 750 bytes to fit this model's context window");
  });

  it('Q2: with the manifest folded away, the diff tool still leads the model to the path', async () => {
    const real = elidedPaths();
    // The fourth read asks by base name only, as a model that lost the manifest might.
    const forgotten = real[3].split('/').pop()!;
    const model = new ScriptedLargePrModel(
      [real[0], real[1], real[2], forgotten, real[3]],
      'FINAL REVIEW'
    );
    await runReview('pr', model, { autocompact: 6000 });

    const answer = model.toolResults[3];
    expect(answer).toContain(`is not one of the ${ENTRIES.length} files`);
    expect(answer).toContain(`"${real[3]}"`);
    expect(model.toolResults[4]).toMatch(/^Diff of /);
  });

  it('Q3: the rating call is made on the compacted state, with the review as its last model turn', async () => {
    const paths = elidedPaths().slice(0, 4);
    const model = new ScriptedLargePrModel(paths, 'FINAL REVIEW');
    await runReview('pr', model, { autocompact: 6000 });

    const rated = model.ratingCalls[0];
    expect(isCompactionSummary(rated[0])).toBe(true);
    expect(rated.some((m) => text(m).includes(MANIFEST_MARKER))).toBe(false);
    const modelTurns = rated.filter((m) => AIMessage.isInstance(m));
    expect(text(modelTurns[modelTurns.length - 1])).toBe('FINAL REVIEW');
    expect(text(rated[rated.length - 1])).toContain(RATE_TOOL);
  });

  it('Q3 (fixed): the rating call is bounded by the guard threshold, with the review whole and no extra model call', async () => {
    const paths = elidedPaths().slice(0, 4);
    // A long review: the guard never sees it, because it is produced by the last guarded call.
    const longReview = 'FINAL REVIEW ' + 'finding. '.repeat(1500);
    const model = new ScriptedLargePrModel(paths, longReview);
    await runReview('pr', model, { autocompact: 6000 });

    const summariesBeforeRating = model.summaryPrompts.length;
    const rated = model.ratingCalls[0];
    expect(rated).toBeDefined();
    // The state it was built from is past the threshold, estimated the way the guard estimates…
    const lastReviewCall = model.reviewCalls[model.reviewCalls.length - 1];
    expect(estimatePromptTokens([...lastReviewCall, new AIMessage(longReview)])).toBeGreaterThan(
      6000
    );
    // …and the request the rater got is not.
    expect(estimatePromptTokens(rated)).toBeLessThanOrEqual(6000);
    expect(isCompactionSummary(rated[0])).toBe(true);
    expect(text(rated[rated.length - 2])).toBe(longReview);
    // The reduction is deterministic: no summariser call was made for the rating.
    expect(model.summaryPrompts.length).toBe(summariesBeforeRating);
    expect(displaySuccess).toHaveBeenCalledWith(expect.stringContaining('PASS 7/10'));
  });

  it('acceptance: a read loop on a known window crosses the threshold, lists after the fold, and every request fits', async () => {
    // A 32k window and no autocompact key: the guard's own default threshold, W − 2048, and the
    // triage budget the source would compute for that window, handed to the tool in the listing.
    const window = 32_768;
    const threshold = window - 2048;
    const budget = diffBudgetBytes(window)!;
    const paths = elidedPaths(budget);
    expect(paths.length).toBeGreaterThan(12);
    const steps: Array<string | { pattern: string }> = [
      ...paths.slice(0, 10),
      { pattern: 'src/**/*.ts' },
      ...paths.slice(10, 12),
    ];
    // A review long enough that the rating request built from the final state would not fit.
    const longReview = 'FINAL REVIEW ' + 'finding. '.repeat(9000);
    const model = new ScriptedLargePrModel(steps, longReview, window);
    await runReview('pr', model, {}, budget);

    // Several turns of reads, and the threshold crossed at least once.
    expect(model.reviewCalls).toHaveLength(steps.length + 1);
    expect(model.summaryPrompts.length).toBeGreaterThanOrEqual(1);
    const hasSummary = (request: BaseMessage[]) => request.some((m) => isCompactionSummary(m));
    // The listing query ran after the first fold, and answered with listed paths only.
    const listingTurn = 11; // the request that carries the listing's result
    expect(hasSummary(model.reviewCalls[listingTurn - 1])).toBe(true);
    expect(model.toolResults[10]).toMatch(/^30 of the 30 files this pull request changes match/);
    expect(model.toolResults[10]).not.toContain('@@');
    // No guarded review request passed the threshold.
    for (const request of model.reviewCalls) {
      expect(estimatePromptTokens(request)).toBeLessThanOrEqual(threshold);
    }
    // One verdict, scored, from a rating request that fits too, with the review whole.
    expect(model.ratingCalls).toHaveLength(1);
    const rated = model.ratingCalls[0];
    const lastReviewCall = model.reviewCalls[model.reviewCalls.length - 1];
    expect(estimatePromptTokens([...lastReviewCall, new AIMessage(longReview)])).toBeGreaterThan(
      threshold
    );
    expect(estimatePromptTokens(rated)).toBeLessThanOrEqual(threshold);
    expect(text(rated[rated.length - 2])).toBe(longReview);
    expect(displaySuccess).toHaveBeenCalledWith(expect.stringContaining('PASS 7/10'));
  });
});
