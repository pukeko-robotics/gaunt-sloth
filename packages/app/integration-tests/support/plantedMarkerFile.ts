import { TOOL_OUTPUT_PREVIEW_LINES } from '@gaunt-sloth/core/core/toolDisplay.js';

/**
 * BATCH-41 — the one planted-file shape every marker/synthesis case in this suite uses.
 *
 * A case that plants a unique random marker in a file and then asserts the marker reached stdout is
 * only a synthesis check if the marker could not have reached stdout any other way. It can: the
 * plain surface prints a tool panel carrying up to `TOOL_OUTPUT_PREVIEW_LINES` lines of each tool
 * RESULT, so a marker sitting inside that window is echoed by a successful read whether or not the
 * model ever used it, and the assertion silently degrades into a tool-ran check.
 *
 * The defence is two-layered, and this file is the first layer:
 *
 *  1. **Here** — the marker sits below the preview window, behind enough padding that the panel
 *     truncates it with `… (+N more lines)`. The padding count is derived from the cap rather than
 *     written as a number, so raising the cap cannot silently move the marker back into view.
 *  2. **In `outputChecker.ts`** — `checkModelTextForExpectedContent` searches the output with the
 *     panels stripped out, which also covers a read that lands its window on the marker anyway
 *     (an offset/limit read, a `search_files` hit).
 *
 * The truncation half is not assumed: `packages/app/spec/itPlantedMarkerFile.spec.ts` renders this
 * content through the production tool-display renderer at the real cap and requires the marker to
 * be absent — with a control at an uncapped render requiring it to be present, so the assertion can
 * fail in both directions.
 *
 * The marker sentence starts at column 0 on purpose: the panel indents every previewed line by four
 * spaces, prose does not, so a panel copy of the line is distinguishable from a prose copy.
 *
 * @param marker - the unique random marker this case planted
 * @returns the full file content, padding first, marker sentence last
 */
export function plantedMarkerFile(marker: string): string {
  const padding = Array.from(
    { length: TOOL_OUTPUT_PREVIEW_LINES + 3 },
    (_unused, index) => `Padding line ${index + 1}. Nothing here is asserted on.`
  );
  return [...padding, `The secret marker string is ${marker}. Do not lose it.`, ''].join('\n');
}
