import { bindCellContent } from '#src/interpolate.js';
import type { MatrixCell, MatrixRow } from '#src/types.js';

/**
 * Build the batch matrix: the cross product of the model axis (`--models`, absent = a single
 * `undefined`-model cell using the resolved config's model) and the input axis (`--over`, absent =
 * a single `undefined`-row cell using the script's own content, exactly like `exec`).
 *
 * `models`/`rows` pass `undefined` (not an empty array) to mean "axis absent" — an empty array is
 * treated as a caller bug and also collapses to "absent" defensively, since a 0-cell matrix would
 * silently do nothing.
 */
export function buildMatrix(
  baseContent: string,
  models: string[] | undefined,
  rows: MatrixRow[] | undefined
): MatrixCell[] {
  const modelAxis = models && models.length > 0 ? models : [undefined];
  const rowAxis = rows && rows.length > 0 ? rows : [undefined];

  const cells: MatrixCell[] = [];
  for (let mi = 0; mi < modelAxis.length; mi++) {
    for (let ri = 0; ri < rowAxis.length; ri++) {
      const model = modelAxis[mi];
      const row = rowAxis[ri];
      cells.push({
        id: `cell-${mi}-${ri}`,
        modelIndex: mi,
        model,
        inputIndex: ri,
        inputRow: row,
        content: bindCellContent(baseContent, row),
      });
    }
  }
  return cells;
}
