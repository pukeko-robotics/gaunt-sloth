import { describe, expect, it } from 'vitest';
import {
  buildToolPreviewLines,
  capToolDisplayLines,
  buildToolBodyLines,
  getToolGlyph,
  summariseToolCall,
  toolStatusDisplay,
  TOOL_OUTPUT_PREVIEW_LINES,
} from '@gaunt-sloth/core/core/toolDisplay.js';
import {
  checkModelTextForExpectedContent,
  checkOutputForExpectedContent,
} from '../integration-tests/support/outputChecker';
import { plantedMarkerFile } from '../integration-tests/support/plantedMarkerFile';

/**
 * BATCH-41 — the unit pins under the marker/synthesis cases' PREMISE.
 *
 * `markerSynthesis.xx-small.it.ts` and `askCommand.xx-small.it.ts` assert that a planted marker
 * appears in the model's own text, and that assertion means something only while the marker cannot
 * reach stdout any other way. The plain surface previews up to `TOOL_OUTPUT_PREVIEW_LINES` lines of
 * every tool result, so the premise is that the planted file's marker falls BELOW that window and
 * the panel truncates it away.
 *
 * That premise was previously assumed. It is asserted here, against the production renderer, with
 * the cap as the variable — so this is not "a string is absent from another string", which is the
 * assertion shape that cannot fail. Each case below pairs the real-cap render with a control render
 * where the marker IS present, so a builder that silently stopped producing a marker at all, or a
 * renderer that stopped emitting a body, would red instead of passing quietly.
 *
 * It lives in the unit suite deliberately: it costs no model call and no GPU, and it goes red on
 * `pnpm run unit` rather than 13 minutes into the real-model gate.
 */

const MARKER = 'MARKER-ASK-a1b2c3d4';
const CONTENT = plantedMarkerFile(MARKER);
const ARGS = JSON.stringify({ path: 'marker.txt' });

/**
 * The tool-result body exactly as the plain surface builds it for a `read_file` whose result is the
 * planted file. `secrets` is passed explicitly so redaction can never depend on this machine's env.
 */
function bodyLines() {
  return buildToolBodyLines({ name: 'read_file', argsText: ARGS, result: CONTENT }, []);
}

/** The panel body rendered at a given preview cap, as one string. */
function renderedAtCap(maxLines: number): string {
  return capToolDisplayLines(bodyLines(), maxLines)
    .map((line) => line.text)
    .join('\n');
}

describe('BATCH-41 planted marker file — the panel-truncation premise', () => {
  it('puts the marker in the file, which is the whole point of planting it', () => {
    expect(CONTENT).toContain(MARKER);
    // And it is the LAST content line, at column 0 — the panel indents every previewed line, so a
    // panel copy stays distinguishable from a prose copy.
    const contentLines = CONTENT.split('\n').filter((line) => line.length > 0);
    expect(contentLines[contentLines.length - 1]).toBe(
      `The secret marker string is ${MARKER}. Do not lose it.`
    );
  });

  it('truncates the marker out of the panel at the CURRENT cap', () => {
    const atRealCap = renderedAtCap(TOOL_OUTPUT_PREVIEW_LINES);

    expect(atRealCap).not.toContain(MARKER);
    // The body was non-empty and genuinely cut — not absent because nothing rendered at all.
    expect(atRealCap).toContain('Padding line 1.');
    expect(atRealCap).toContain('more lines');
  });

  it('CONTROL: the same renderer shows the marker when nothing is cut', () => {
    // The discriminating half. Without this, the case above is "a string is absent from a string"
    // and would keep passing if the builder stopped planting a marker or the renderer stopped
    // producing a body. Render the same body with the cap raised past its length and the marker
    // must appear — so the absence above is the CAP's doing.
    const uncapped = renderedAtCap(bodyLines().length);

    expect(uncapped).toContain(MARKER);
    expect(uncapped).not.toContain('more lines');
  });

  it('is truncated by the production preview path, not only by a hand-applied cap', () => {
    // `buildToolPreviewLines` is what `plainToolIndication` actually calls; the cases above go
    // through `capToolDisplayLines` so the cap can be varied. Both must agree at the real cap.
    const preview = buildToolPreviewLines(
      { name: 'read_file', argsText: ARGS, result: CONTENT },
      []
    )
      .map((line) => line.text)
      .join('\n');

    expect(preview).not.toContain(MARKER);
    expect(preview).toContain('more lines');
  });

  it('keeps the marker below the window with room to spare, at whatever the cap is', () => {
    // The padding is derived from the cap rather than hardcoded. If someone replaces it with a
    // number, this is what notices: the marker line's index must stay past the cap.
    const markerLineIndex = CONTENT.split('\n').findIndex((line) => line.includes(MARKER));

    expect(markerLineIndex).toBeGreaterThan(TOOL_OUTPUT_PREVIEW_LINES);
  });
});

/**
 * The deterministic twin of the real-model discrimination case: a run in which the tool DID run and
 * returned the planted file, and the model said nothing useful afterwards. The marker/synthesis
 * assertion must be FALSE there — that is the case the pre-BATCH-41 check could not fail, because
 * the one-line marker file it planted was echoed whole by the panel.
 */
describe('BATCH-41 planted marker file — a tool-ran-but-did-not-synthesize run', () => {
  /** One plain-surface panel for the `read_file` of the planted file, as the surface prints it. */
  function panel(): string[] {
    const head = `${toolStatusDisplay({}).glyph} ${getToolGlyph('read_file')} ${summariseToolCall('read_file', ARGS, [])}`;
    // The four-space indent `plainToolIndication` puts in front of every previewed line.
    const body = buildToolPreviewLines(
      { name: 'read_file', argsText: ARGS, result: CONTENT },
      []
    ).map((line) => `    ${line.text}`);
    return ['', head, ...body];
  }

  function runEndingWith(answer: string): string {
    return [
      'Gaunt Sloth · ask · gemma4:12b (ollama)',
      '',
      'Requested tools: read_file(path: marker.txt)',
      ...panel(),
      answer,
    ].join('\n');
  }

  it('reds when the model answers without the marker, while the tool evidence still stands', () => {
    const output = runEndingWith('I read the file.');

    expect(checkOutputForExpectedContent(output, 'Requested tools:')).toBe(true);
    expect(checkModelTextForExpectedContent(output, MARKER)).toBe(false);
    // And the marker is nowhere in the RAW output either: the padding kept it out of the panel, so
    // the old raw-output check would have failed on this run too. That is the fix, stated as a
    // measurement — before it, this exact run passed.
    expect(checkOutputForExpectedContent(output, MARKER)).toBe(false);
  });

  it('CONTROL: passes when the model does report the marker', () => {
    const output = runEndingWith(`The secret marker string is ${MARKER}.`);

    expect(checkModelTextForExpectedContent(output, MARKER)).toBe(true);
  });
});
