/**
 * @packageDocumentation
 * Default Gaunt Sloth configuration ({@link DEFAULT_CONFIG}). Extracted verbatim from
 * the former `config.ts` god-file; values are unchanged.
 */
import { PROJECT_GUIDELINES, PROJECT_REVIEW_INSTRUCTIONS } from '#src/constants.js';
import { StatusLevel } from '#src/core/types.js';
import type { GthConfig } from '#src/config/types.js';

/**
 * Default config
 */
export const DEFAULT_CONFIG = {
  contentSource: 'file',
  requirementSource: 'file',
  /**
   * Path to project-specific guidelines.
   * The default is `.gsloth.guidelines.md`; this config may be used to point Gaunt Sloth to a different file,
   * for example, to AGENTS.md
   */
  projectGuidelines: PROJECT_GUIDELINES,
  /**
   * Whether to include the current date in the project review instructions or not.
   */
  includeCurrentDateAfterGuidelines: false,
  projectReviewInstructions: PROJECT_REVIEW_INSTRUCTIONS,
  filesystem: 'none',
  // Enabled built-in tools. `gth_checklist` (the lean agent's planning/todo tool) and `gth_grep`
  // (the permission-light content-search tool, GS2-51) are on by default across commands; a user
  // `builtInTools` setting replaces this set entirely. Both are named to coexist with the deep
  // backend's own `write_todos`/`grep` built-ins. Cast keeps it a mutable `string[]` under the
  // surrounding `as const`.
  builtInTools: ['gth_checklist', 'gth_grep'] as string[],
  debugLog: false,
  consoleLevel: StatusLevel.INFO, // Default to INFO level, not debug
  /**
   * Default source for both requirements and content is GitHub.
   * It needs GitHub CLI (gh).
   *
   * `github` content source uses `gh pr diff NN` internally. {@link src/sources/ghPrDiffSource.ts!}
   *
   *
   * `github` requirement source uses `gh issue view NN` internally
   */
  commands: {
    pr: {
      contentSource: 'github',
      requirementSource: 'github',
      rating: {
        enabled: true,
        passThreshold: 6,
        minRating: 0,
        maxRating: 10,
        errorOnReviewFail: true,
      },
    },
    review: {
      rating: {
        enabled: true,
        passThreshold: 6,
        minRating: 0,
        maxRating: 10,
        errorOnReviewFail: true,
      },
    },
    ask: {
      filesystem: 'read',
    },
    chat: {
      filesystem: 'read',
    },
    code: {
      filesystem: 'all',
    },
    exec: {
      filesystem: 'all',
    },
    api: {
      filesystem: 'read',
      port: 3000,
      cors: {
        allowOrigin: 'http://localhost:3000',
        allowMethods: 'POST, GET, OPTIONS',
        allowHeaders: 'Content-Type, Accept',
      },
    },
  },
  streamOutput: true,
  writeOutputToFile: false,
  writeBinaryOutputsToFile: true,
  useColour: true,
  streamSessionInferenceLog: true,
  canInterruptInferenceWithEsc: true,
  aiignore: {
    enabled: true,
    patterns: undefined,
  },
} as const;

/**
 * Needed DEFAULT_CONFIG to be plain const to be picked up by typedoc,
 * this cast here is just for typecheck.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-expressions
DEFAULT_CONFIG as GthConfig;
