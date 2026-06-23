/**
 * @module tools/shell/outputBuffer
 *
 * Bounded capture of a shell command's combined stdout/stderr for the value
 * returned to the model. A noisy build/test log can be megabytes; dumping it
 * verbatim into a ToolMessage blows the context window. This buffer keeps a
 * HEAD window (the first N bytes) and a TAIL ring-buffer (the last N bytes) and
 * drops the middle, while accumulating the FULL output separately so it can be
 * spilled to a temp file the model can re-read with `read_file`.
 *
 * Live streaming to the terminal is unaffected — the toolkit still writes every
 * chunk to stdout as it arrives; only the returned string is capped.
 *
 * Patterned after opencode `bash.ts` (per-stream cap + temp-file tail) and
 * openclaw `bash-tools.shared.ts` `truncateMiddle`.
 */
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export interface CappedOutput {
  /** The bounded text to surface to the model (head + tail with a gap note). */
  text: string;
  /** True when the output exceeded the budget and was truncated. */
  truncated: boolean;
  /** Total bytes captured (the full, untruncated size). */
  totalBytes: number;
  /** Absolute path to the spilled full output, or undefined when not truncated. */
  spillPath?: string;
}

/**
 * Accumulates command output up to a byte budget using a head + tail window.
 * The full output is retained in memory so it can be spilled to disk on demand;
 * the in-memory full copy is itself bounded at a hard safety ceiling to avoid
 * unbounded growth from a runaway command.
 */
export class OutputBuffer {
  private head = '';
  private headBytes = 0;
  private readonly tailChunks: string[] = [];
  private tailBytes = 0;
  private totalBytesCount = 0;
  /** Full copy for spillover, bounded by a hard ceiling. */
  private full = '';
  private fullTruncated = false;

  private readonly headBudget: number;
  private readonly tailBudget: number;
  private readonly fullCeiling: number;

  /**
   * @param maxOutputBytes total byte budget for the returned (head+tail) window.
   * @param fullCeiling hard ceiling for the in-memory full copy kept for spillover.
   *        Defaults to a generous 16MB so the spill file holds the real output for
   *        typical noisy logs, while still bounding memory for a runaway command.
   */
  constructor(maxOutputBytes: number, fullCeiling = 16 * 1024 * 1024) {
    // Split the budget evenly between head and tail.
    this.headBudget = Math.max(1, Math.floor(maxOutputBytes / 2));
    this.tailBudget = Math.max(1, maxOutputBytes - this.headBudget);
    // The full copy must hold at least the preview window.
    this.fullCeiling = Math.max(fullCeiling, maxOutputBytes);
  }

  /** Append a chunk of output. Byte accounting uses UTF-8 byte length. */
  append(chunk: string): void {
    const bytes = Buffer.byteLength(chunk, 'utf8');
    this.totalBytesCount += bytes;

    // Maintain the full copy up to the ceiling (for spillover). Store as much of
    // an oversized chunk as fits rather than dropping it wholesale.
    if (!this.fullTruncated) {
      const used = Buffer.byteLength(this.full, 'utf8');
      const room = this.fullCeiling - used;
      if (bytes <= room) {
        this.full += chunk;
      } else {
        if (room > 0) {
          this.full += Buffer.from(chunk, 'utf8').subarray(0, room).toString('utf8');
        }
        this.fullTruncated = true;
      }
    }

    // Fill the head window first.
    if (this.headBytes < this.headBudget) {
      const room = this.headBudget - this.headBytes;
      if (bytes <= room) {
        this.head += chunk;
        this.headBytes += bytes;
        return;
      }
      // Partial: take what fits into head, the rest flows to tail.
      const take = Buffer.from(chunk, 'utf8').subarray(0, room).toString('utf8');
      this.head += take;
      this.headBytes += Buffer.byteLength(take, 'utf8');
      const rest = chunk.slice(take.length);
      this.pushTail(rest);
      return;
    }

    this.pushTail(chunk);
  }

  /** Push into the tail ring-buffer, evicting oldest data beyond the budget. */
  private pushTail(chunk: string): void {
    if (chunk.length === 0) return;
    this.tailChunks.push(chunk);
    this.tailBytes += Buffer.byteLength(chunk, 'utf8');
    while (this.tailBytes > this.tailBudget && this.tailChunks.length > 1) {
      const removed = this.tailChunks.shift()!;
      this.tailBytes -= Buffer.byteLength(removed, 'utf8');
    }
    // If a single chunk alone exceeds the tail budget, trim it from the front.
    if (this.tailBytes > this.tailBudget && this.tailChunks.length === 1) {
      const only = this.tailChunks[0];
      const overflow = this.tailBytes - this.tailBudget;
      const buf = Buffer.from(only, 'utf8');
      const trimmed = buf.subarray(overflow).toString('utf8');
      this.tailChunks[0] = trimmed;
      this.tailBytes = Buffer.byteLength(trimmed, 'utf8');
    }
  }

  get totalBytes(): number {
    return this.totalBytesCount;
  }

  get isTruncated(): boolean {
    return this.totalBytesCount > this.headBytes + this.tailBytes;
  }

  /** The full captured output (bounded by the in-memory ceiling). */
  getFull(): string {
    return this.full;
  }

  /**
   * Finalize the capture. When not truncated, returns the output verbatim. When
   * truncated, spills the full output to a temp file and returns head + a gap
   * note (with the file path) + tail.
   *
   * @param spill optional injected spill function (path-returning) for testing.
   *        Defaults to writing into `os.tmpdir()`.
   */
  finalize(spill: (content: string) => string = defaultSpill): CappedOutput {
    const tail = this.tailChunks.join('');
    if (!this.isTruncated) {
      return {
        text: this.head + tail,
        truncated: false,
        totalBytes: this.totalBytesCount,
      };
    }

    const spillPath = spill(this.full);
    const fullNote = this.fullTruncated
      ? `First ${Buffer.byteLength(this.full, 'utf8')} bytes`
      : 'Full output';
    const droppedNote =
      `\n\n... [output truncated: ${this.totalBytesCount} bytes total; ` +
      `showing first ${this.headBytes} + last ${this.tailBytes} bytes. ` +
      `${fullNote} written to ${spillPath} — use read_file to inspect.] ...\n\n`;
    return {
      text: this.head + droppedNote + tail,
      truncated: true,
      totalBytes: this.totalBytesCount,
      spillPath,
    };
  }
}

/** Default spill: write to a uniquely-named file in the OS temp dir. */
function defaultSpill(content: string): string {
  const name = `gsloth-shell-${Date.now()}-${Math.random().toString(36).slice(2, 10)}.log`;
  const filePath = path.join(tmpdir(), name);
  writeFileSync(filePath, content, 'utf8');
  return filePath;
}
