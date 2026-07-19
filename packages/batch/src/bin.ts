#!/usr/bin/env node
/**
 * @module bin
 *
 * BATCH-9 — the `gth-batch` executable. A minimal shebang wrapper around {@link runBatchCli}
 * (pipelineCli.ts) whose only job beyond delegating is to keep **stdout a clean machine channel**: the
 * batch runtime's human/status/streaming output all lands on `process.stdout` (via
 * `console.*`/`ProgressIndicator`/`stream()`), so this redirects `process.stdout.write` to stderr
 * for the duration of the run. The JSONL cell records are written straight to fd 1 inside
 * `runBatchCli` (`fs.writeSync`), bypassing this redirect — the same "protocol channel" discipline
 * `packages/app/cli.js` uses for the ACP stdio channel.
 */

import { runBatchCli } from '#src/pipelineCli.js';

const originalStdoutWrite = process.stdout.write.bind(process.stdout);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
process.stdout.write = ((chunk: any, encoding?: any, cb?: any): boolean =>
  process.stderr.write(chunk, encoding, cb)) as typeof process.stdout.write;

runBatchCli(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    process.stderr.write(`gth-batch: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  })
  .finally(() => {
    process.stdout.write = originalStdoutWrite;
  });
