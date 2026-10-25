#!/usr/bin/env node

/**
 * Simple CLI for gaunt-sloth-review
 * Usage: gaunt-sloth-review [pr-number-or-content] [requirements...]
 *
 * When called with a PR number, reviews the specified PR using the configured content provider.
 * When called without arguments, reads diff from stdin via the configured content provider.
 */

import { createRequire } from 'node:module';

const args = process.argv.slice(2);

if (args.includes('--version') || args.includes('-v')) {
  const require = createRequire(import.meta.url);
  const { version } = require('./package.json');
  console.log(version);
  process.exit(0);
}

import { setEntryPoint } from '@gaunt-sloth/core/utils/systemUtils.js';
setEntryPoint(import.meta.url);

import { initConfig } from '@gaunt-sloth/core/config.js';
import { review } from '#src/modules/reviewModule.js';
import { writeReviewFailureReport } from '#src/modules/reviewFailureReport.js';
import { displayError } from '@gaunt-sloth/core/utils/consoleUtils.js';
import {
  getContentFromSource,
  getRequirementsFromSource,
  getReviewPreamble,
  resolvePrIdFromArg,
} from '#src/commands/commandUtils.js';

/** The source label this bin passes to `review()`, and therefore names its report file with. */
const REVIEW_SOURCE = 'pr-review';

async function main() {
  // REL-20 — the run is in two phases with two catches, because only the first one owes a report.
  //
  // Everything up to `review()` happens before the report file exists, so a failure there is the
  // one that leaves a workflow reading `review.md` with nothing to read; it writes the report
  // itself. Once `review()` is running the file is already open and captures its own failures, so
  // the second catch stays as it was — writing a report over that one would replace a review that
  // got part-way with a bare error.
  //
  // `gth pr` / `gth review` keep the same promise through the same helper. A second copy of the
  // report-writing here is how the two entry points would drift apart.
  let config;
  let diffWithReqs;
  let contentArg;
  let preambleText;
  // REL-6 — set by the github source when its triage named files without their diff; passed to
  // `review()`, where it gives the agent the per-file diff tool.
  let largePr;
  try {
    config = await initConfig({
      identityProfile: process.env.GSLOTH_IDENTITY_PROFILE,
    });

    // First arg is content (e.g. PR number), rest are requirements
    contentArg = args[0];
    const requirementArgs = args.slice(1);

    // Get content (e.g. PR diff)
    const contentSource = config.commands?.pr?.contentSource || config.contentSource || 'github';
    const content = await getContentFromSource(contentSource, contentArg, config, {
      command: 'pr',
      onLargePr: (listing) => {
        largePr = listing;
      },
    });

    // Get requirements if provided
    let requirements = '';
    if (requirementArgs.length > 0) {
      const reqSource =
        config.commands?.pr?.requirementSource || config.requirementSource || 'github';
      for (const reqArg of requirementArgs) {
        const req = await getRequirementsFromSource(reqSource, reqArg, config);
        if (req) requirements += req + '\n';
      }
    }

    // Combine requirements and content for the review
    diffWithReqs = requirements ? `Requirements:\n${requirements}\nDiff:\n${content}` : content;

    // Build the review preamble (backstory + guidelines + review instructions + optional
    // system prompt), the same composition `gth review` / `gth pr` use. In this phase because it
    // reads files off disk and can fail, and a failure there is still a run that never reached the
    // agent.
    preambleText = getReviewPreamble(config);
  } catch (error) {
    displayError(error instanceof Error ? error.message : String(error));
    // `config` is undefined when `initConfig` itself threw; the helper knows there is no path to
    // write to in that case and does nothing.
    writeReviewFailureReport(config, REVIEW_SOURCE, 'pr', error);
    process.exit(1);
  }

  try {
    // Pass the PR id on so GitHub-only tools address the PR explicitly instead of trying to
    // resolve it from the checked-out branch, which a CI runner's detached HEAD cannot provide.
    await review(REVIEW_SOURCE, preambleText, diffWithReqs, config, 'pr', undefined, {
      prId: resolvePrIdFromArg(contentArg),
      largePr,
    });
  } catch (error) {
    displayError(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

main();
