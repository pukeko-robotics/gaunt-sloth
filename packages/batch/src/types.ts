/**
 * @packageDocumentation
 * BATCH-1 — the shapes shared across matrix construction, the concurrency/retry runner, and the
 * structured output writer. Deliberately independent of any LLM/runner types (`GthConfig`,
 * `runSingleShot`, …): this package only knows about *cells* and *outcomes*. The production
 * adapter that turns a cell into an actual `runSingleShot` call lives in
 * `packages/app/src/commands/batchCommand.ts`, which is what keeps {@link RunCellFn} injectable —
 * unit tests here fake it, the CLI wires the real one.
 */

/** One row/record parsed from `--over <path.csv|path.jsonl>`. Values are always strings for csv. */
export type MatrixRow = Record<string, string>;

/**
 * One cell of the batch matrix — the cross product of the model axis (`--models`) and the input
 * axis (`--over`). Either axis may be absent (single cell using the resolved config's model and/or
 * the script's own content, mirroring `exec` with no matrix at all).
 */
export interface MatrixCell {
  /**
   * Filename-safe, deterministic identifier: `cell-<modelIndex>-<rowIndex>` (0-based; both
   * default to 0 when their axis is absent). Never derived from the model name or row content so
   * it stays stable and filesystem-safe regardless of what a model/provider string or row data
   * contains.
   */
  id: string;
  /** 0-based index into the (possibly single-element) model axis. */
  modelIndex: number;
  /** The model name for this cell, when `--models` was supplied. Absent = the configured model. */
  model?: string;
  /** 0-based index into the (possibly single-element) input axis. */
  inputIndex: number;
  /** The source row for this cell, when `--over` was supplied. Absent = no input axis. */
  inputRow?: MatrixRow;
  /** The fully-bound prompt content for this cell (base script content with the row interpolated). */
  content: string;
}

/** What one attempt at running a cell through the shared single-shot runtime produced. */
export interface CellRunOutcome {
  /** `true` when the cell's run completed without error; mirrors `runSingleShot`'s contract. */
  ok: boolean;
  /**
   * The model's final answer text, when the injected run-cell function can cleanly obtain it.
   * The production adapter (wired around `runSingleShot`) cannot — see the BATCH-1 task report for
   * why — so this is `undefined` for real runs today; fakes used in tests may populate it.
   */
  answer?: string;
  /** Total prompt/input tokens for the run, when available (see {@link answer}'s caveat). */
  tokensInput?: number;
  /** Total completion/output tokens for the run, when available (see {@link answer}'s caveat). */
  tokensOutput?: number;
  /** Names of tools invoked during the run, when available (see {@link answer}'s caveat). */
  tools?: string[];
  /** A human-readable failure reason, set when `ok` is `false`. */
  error?: string;
}

/**
 * Injectable "run one prompt" function — the seam that lets {@link runBatchMatrix} be fully unit
 * tested without any real LLM call. The production wiring (`batchCommand.ts`) adapts
 * `runSingleShot` to this shape; tests inject a fake that resolves/rejects/throws as needed.
 */
export type RunCellFn = (cell: MatrixCell) => Promise<CellRunOutcome>;

/** One cell's full structured record, as written to `<id>.json` and summarized in `results.json`. */
export interface CellResult extends CellRunOutcome {
  id: string;
  model?: string;
  inputIndex: number;
  /** The source row for this cell, echoed for traceability (absent when no `--over` was given). */
  inputRow?: MatrixRow;
  /** Wall-clock time across all attempts (including retries) for this cell, in milliseconds. */
  durationMs: number;
  /** How many retries were consumed (0 = succeeded, or failed, on the first attempt). */
  retries: number;
}

/** Options for {@link runBatchMatrix}. */
export interface BatchRunnerOptions {
  /** Max in-flight cells. Must be >= 1; non-finite/invalid values fall back to the default. */
  concurrency?: number;
  /** Number of retries on a failed cell (0 = no retry, the default). */
  retry?: number;
  /** The injectable per-cell run function (see {@link RunCellFn}). */
  runCell: RunCellFn;
}

/** A lightweight, `--repeat`-free version of the "flake report" §3 of the requirements asks for. */
export interface BatchSummary {
  total: number;
  passed: number;
  failed: number;
  cells: Array<{
    id: string;
    model?: string;
    inputIndex: number;
    ok: boolean;
    retries: number;
  }>;
}

/** The default concurrency cap when `-j/--concurrency` is not supplied. */
export const DEFAULT_CONCURRENCY = 4;
