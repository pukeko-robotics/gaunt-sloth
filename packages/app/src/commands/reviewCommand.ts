import { Command, Option } from 'commander';
import { displayError, displayInfo } from '@gaunt-sloth/core/utils/consoleUtils.js';
import { getStringFromStdin, setExitCode, stdout } from '@gaunt-sloth/core/utils/systemUtils.js';
import { ApprovalStopError, approvalStopRows } from '@gaunt-sloth/core/core/shell/approvalStop.js';
import {
  getCommandSourceInput,
  getEffectiveContentSource,
  getEffectiveRequirementSource,
  getReviewSystemPrompt,
  withReviewContentSource,
} from '#src/commands/commandIntrospection.js';
import {
  REQUIREMENTS_SOURCES,
  CONTENT_SOURCES,
  type RequirementSourceType,
  type ContentSourceType,
} from '#src/commands/commandUtils.js';
import { CommandLineConfigOverrides } from '@gaunt-sloth/core/config.js';
import { wrapContent } from '@gaunt-sloth/core/utils/llmUtils.js';

import { readMultipleFilesFromProjectDir } from '@gaunt-sloth/review/utils/fileUtils.js';
// From the REVIEW package, not this package's own same-named module: both ship a
// `commands/commandUtils`, and this helper lives only in review's (GS2-45).
import { resolvePrIdFromArg } from '@gaunt-sloth/review/commands/commandUtils.js';
import { extractChangedPathsFromDiff } from '@gaunt-sloth/review/utils/diffPaths.js';
import { writeReviewFailureReport } from '@gaunt-sloth/review/modules/reviewFailureReport.js';

/** The source label this command passes to `review()`, and therefore names its report file with. */
const REVIEW_SOURCE = 'REVIEW';

interface ReviewCommandOptions {
  file?: string[];
  requirements?: string;
  requirementsSource?: RequirementSourceType;
  contentSource?: ContentSourceType;
  message?: string;
}

export function reviewCommand(
  program: Command,
  cliConfigOverrides: CommandLineConfigOverrides
): void {
  program
    .command('review')
    .description('Review provided diff or other content')
    .argument(
      '[contentId]',
      'Optional content ID argument to retrieve content with content source. ' +
        'For the git content source this is an optional ref range, e.g. origin/main...HEAD'
    )
    .alias('r')
    .option(
      '-f, --file [files...]',
      'Input files. Content of these files will be added BEFORE the diff, but after requirements'
    )
    .option('-r, --requirements <requirements>', 'Requirements for this review.')
    .addOption(
      new Option(
        '-p, --requirements-source <requirementSource>',
        'Requirement source for this review.'
      ).choices(Object.keys(REQUIREMENTS_SOURCES))
    )
    .addOption(
      new Option('--content-source <contentSource>', 'Content source').choices(
        Object.keys(CONTENT_SOURCES)
      )
    )
    .option('-m, --message <message>', 'Extra message to provide just before the content')
    .addHelpText(
      'after',
      '\n' +
        'Examples:\n' +
        '  $ git --no-pager diff | gth review\n' +
        '  $ gth review --content-source git\n' +
        '  $ gth review origin/main...HEAD --content-source git\n' +
        '  $ gth review -r requirements.md\n' +
        '  $ git diff | gth review -m "Please focus on security implications"\n'
    )
    .action(async (contentId: string | undefined, options: ReviewCommandOptions) => {
      const { initConfig } = await import('@gaunt-sloth/core/config.js');
      const initialConfig = await initConfig(cliConfigOverrides); // Initialize and get config
      const content: string[] = [];
      const requirementsId = options.requirements;
      const requirementSource = getEffectiveRequirementSource(
        'review',
        initialConfig,
        options.requirementsSource
      );
      const contentSource = getEffectiveContentSource(
        'review',
        initialConfig,
        options.contentSource
      );
      // Everything below runs against a config that AGREES with the source above, so a decision
      // made on config (the review module's `gth_gh_read_file` gate) can never disagree with where
      // the diff actually came from.
      const config = withReviewContentSource(initialConfig, contentSource);

      // CFG-80 — discovery runs only when enabled and no `--requirements` was given; an explicit
      // `--requirements` always wins.
      const discoverRequirements =
        !requirementsId && config.commands?.review?.discovery?.enabled === true;

      // With discovery on and no id, the requirement source is not asked for an id-less lookup:
      // discovery is what finds the id, and the id-less call only warns (the Jira source prints
      // "No issue ID provided") — the same reason `gth pr` skips it in discovery mode.
      if (!discoverRequirements) {
        const requirements = await getCommandSourceInput(
          'review',
          'requirements',
          requirementsId,
          config,
          requirementSource
        );
        if (requirements) {
          content.push(requirements);
        }
      }

      // Fail loudly on a content-source error (e.g. the git source outside a repository or with
      // an empty diff) instead of surfacing a raw unhandled rejection — same shape as `gth pr`.
      let providedContent: string;
      try {
        providedContent = await getCommandSourceInput(
          'review',
          'content',
          contentId,
          config,
          contentSource
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        displayError(message);
        // REL-20 — `gth review` fails before inference the same way `gth pr` does (the git source
        // outside a repository, the GitHub source on a diff too large to fetch), so it owes the
        // same report. The two commands share this exit; they must not diverge on it.
        writeReviewFailureReport(config, REVIEW_SOURCE, 'review', message);
        setExitCode(1);
        return;
      }
      // CFG-70 — the changed paths come from `providedContent` alone, never from `content`, which
      // by the time it is passed also holds the requirements, the `--file` contents, stdin and
      // `--message`. A requirements document that quotes a diff would otherwise inject paths this
      // change never touched, attaching another module's guidelines to it.
      //
      // Inside the same truthiness guard as the push: `getCommandSourceInput` is TYPED as
      // returning a string but resolves to nothing when a source produces no content, which is
      // what the guard below has always been for.
      let changedPaths: string[] = [];
      if (providedContent) {
        changedPaths = extractChangedPathsFromDiff(providedContent);
        content.push(providedContent);
      }

      // CFG-80 — requirements discovery. After the content fetch, so a review that cannot get its
      // diff never spends a discovery agent run; the discovered requirements still go FIRST in the
      // content, where `--requirements` puts them. With discovery off (the default) nothing here
      // runs: no git, no gh, no agent, so the review runs and prints exactly what it did before.
      if (discoverRequirements) {
        const { runReviewDiscovery } = await import('#src/commands/reviewDiscovery.js');
        try {
          const discovered = await runReviewDiscovery(config, requirementSource);
          if (discovered) {
            content.unshift(wrapContent(discovered, 'discovered-requirements', 'requirements'));
          } else {
            displayInfo('Requirements discovery found no requirements; reviewing without them.');
          }
        } catch (error) {
          // Same handling as `gth pr`'s discovery: the agent runs inside a try/finally with no
          // catch of its own, so an approvals stop or a provider error from it lands here. It fails
          // the run rather than silently reviewing without the requirements the user asked for.
          if (error instanceof ApprovalStopError) {
            for (const row of approvalStopRows(error.parts, { columns: stdout.columns })) {
              displayError(row);
            }
            writeReviewFailureReport(config, REVIEW_SOURCE, 'review', error.message);
          } else {
            const message = error instanceof Error ? error.message : String(error);
            displayError(message);
            writeReviewFailureReport(config, REVIEW_SOURCE, 'review', message);
          }
          setExitCode(1);
          return;
        }
      }

      if (options.file) {
        content.push(readMultipleFilesFromProjectDir(options.file));
      }
      const stringFromStdin = getStringFromStdin();
      if (stringFromStdin) {
        content.push(wrapContent(stringFromStdin, 'stdin-content'));
      }
      if (options.message) {
        content.push(wrapContent(options.message, 'message', 'user message'));
      }
      const { review } = await import('@gaunt-sloth/review/modules/reviewModule.js');
      const { createResolvers } = await import('@gaunt-sloth/agent/resolvers.js');
      await review(
        REVIEW_SOURCE,
        getReviewSystemPrompt(config),
        content.join('\n'),
        config,
        'review',
        createResolvers(),
        // Bind GitHub-only review tools (gth_gh_read_file) to the pull request this run's DIFF
        // came from. Without it they resolve the PR from the checked-out branch instead, so a
        // `gth review 42 --content-source github` reviews PR 42's diff against a different pull
        // request's files, silently. `contentId` is a content id rather than a PR id — a ref
        // range or a file path under the other sources — so only a bare number is taken as one;
        // anything else, including no argument at all, keeps the branch-discovery fallback.
        { prId: resolvePrIdFromArg(contentId), changedPaths }
      );
    });
}
