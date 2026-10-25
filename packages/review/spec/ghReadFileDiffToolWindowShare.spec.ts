import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { compactionCutIndex, DEFAULT_KEEP_RECENT } from '@gaunt-sloth/core/core/compaction.js';
import { seedAutocompactThreshold } from '@gaunt-sloth/core/core/compactionThreshold.js';
import {
  DEFAULT_OUTPUT_RESERVE_TOKENS,
  defaultCompactionThreshold,
  estimatePromptTokens,
} from '@gaunt-sloth/core/core/GthLangChainAgent.js';
import { GH_READ_FILE_DIFF_DEFAULT_MAX_BYTES } from '@gaunt-sloth/core/config.js';
import {
  effectiveDiffReadCapBytes,
  readFileDiffFromListing,
  READ_SHARE_OF_DIFF_BUDGET,
} from '#src/tools/ghReadFileDiffTool.js';
import { diffBudgetBytes, UNKNOWN_WINDOW_FALLBACK_TOKENS } from '#src/utils/prDiffTriage.js';
import type { PrFileEntry } from '#src/utils/prFilesListing.js';

/**
 * REL-6 — **the arithmetic behind `READ_SHARE_OF_DIFF_BUDGET`, against the real constants.**
 *
 * Nothing here re-derives the share with the source's own formula. It builds the requests a large-PR
 * review loop actually sends — a first message as large as the triage budget allows, the real
 * system prompt files, and real capped answers from the tool — runs them through core's real
 * estimator, finds with core's real cut rule which of them cannot fold, and checks them against the
 * real threshold. A change to `DEFAULT_KEEP_RECENT`, the estimator, the reserve, the seed fraction
 * or the triage budget turns a cell here red instead of silently reopening the overflow.
 */

/** The default prompts a `pr` review is composed from: what the guard counts as the system prompt. */
const DEFAULT_PROMPT_FILES = [
  '../../core/.gsloth.system.md',
  '../../core/.gsloth.backstory.md',
  '../../core/.gsloth.guidelines.md',
  '../../core/.gsloth.review.md',
  '../../app/.gsloth.pr-discovery.md',
];
const SYSTEM_PROMPT_CHARACTERS = DEFAULT_PROMPT_FILES.reduce(
  (total, file) =>
    total + readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8').length,
  0
);

/** The windows the share must close on: 32k up, and the triage's unknown-window fallback. */
const WINDOWS = [32_768, 65_536, UNKNOWN_WINDOW_FALLBACK_TOKENS, 200_000, 1_000_000];

/** The lower of the two thresholds a run can have without the user naming one. */
function guardThreshold(window: number): number {
  return Math.min(
    defaultCompactionThreshold(window, DEFAULT_OUTPUT_RESERVE_TOKENS, false),
    seedAutocompactThreshold(window)!
  );
}

/** A read the tool answers at its cap: a path whose patch is far larger than any cap. */
function cappedRead(index: number, cap: number): BaseMessage[] {
  const filePath = `src/module${index}/index.ts`;
  const entry: PrFileEntry = {
    path: filePath,
    status: 'modified',
    additions: 9000,
    deletions: 0,
    patch: `@@ -0,0 +1,9000 @@\n${'+const value = compute(input);\n'.repeat(9000)}`,
  };
  const answer = readFileDiffFromListing({ path: filePath }, [entry], cap);
  return [
    new AIMessage({
      content: '',
      tool_calls: [{ name: 'gth_gh_read_file_diff', args: { path: filePath }, id: `r${index}` }],
    }),
    new ToolMessage({ content: answer, tool_call_id: `r${index}` }),
  ];
}

function conversation(window: number, reads: number, cap: number): BaseMessage[] {
  const first = new HumanMessage('x'.repeat(diffBudgetBytes(window)!));
  return [first, ...Array.from({ length: reads }, (_, i) => cappedRead(i, cap)).flat()];
}

/**
 * The most whole tool results that sit beside each other unfolded, by core's own cut rule: the
 * reads before anything can fold, or the reads in the tail kept after a fold, whichever is more.
 */
function unfoldedReads(): number {
  let beforeFirstFold = 0;
  while (compactionCutIndex(conversation(32_768, beforeFirstFold + 1, 10)) === null) {
    beforeFirstFold++;
  }
  const atFirstFold = conversation(32_768, beforeFirstFold + 1, 10);
  const cut = compactionCutIndex(atFirstFold)!;
  const keptTail = atFirstFold.slice(cut).filter((m) => ToolMessage.isInstance(m)).length;
  return Math.max(beforeFirstFold, keptTail);
}

describe('REL-6 — the diff tool’s window share closes the review loop’s arithmetic', () => {
  it('three whole results sit unfolded under the real DEFAULT_KEEP_RECENT', () => {
    expect(DEFAULT_KEEP_RECENT).toBe(6);
    expect(unfoldedReads()).toBe(3);
  });

  for (const window of WINDOWS) {
    it(`a ${window}-token window: the first message, the system prompt and the unfolded reads fit the threshold`, () => {
      const cap = effectiveDiffReadCapBytes(
        GH_READ_FILE_DIFF_DEFAULT_MAX_BYTES,
        diffBudgetBytes(window)!
      );
      const request = conversation(window, unfoldedReads(), cap);
      // Every read really is at its cap, so this is the worst case and not a lucky small one.
      for (const message of request.filter((m) => ToolMessage.isInstance(m))) {
        expect(String(message.content)).toContain('INCOMPLETE');
      }
      expect(estimatePromptTokens(request, SYSTEM_PROMPT_CHARACTERS)).toBeLessThanOrEqual(
        guardThreshold(window)
      );
    });
  }

  it('the control: twice the share does not fit a 32k window, so the cells above can fail', () => {
    const window = 32_768;
    const doubled = Math.floor(diffBudgetBytes(window)! * READ_SHARE_OF_DIFF_BUDGET * 2);
    const request = conversation(window, unfoldedReads(), doubled);
    expect(estimatePromptTokens(request, SYSTEM_PROMPT_CHARACTERS)).toBeGreaterThan(
      guardThreshold(window)
    );
  });
});
