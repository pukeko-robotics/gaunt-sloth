// Runner for the Stage D PTY e2e (Ink TUI). tui-test copies its cwd tree into a transpiled
// cache and reads config/tests relative to process.cwd(), so the e2e MUST run from the
// `tui-e2e` folder (otherwise it would copy the whole package — including deliberately broken
// IT fixtures — and swc would choke). `npm run` + `npx` reorients cwd unpredictably, so we
// spawn the runner ourselves with an explicit cwd instead of relying on a shell `cd`.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const e2eDir = path.join(here, 'tui-e2e');
const bin = createRequire(import.meta.url).resolve('@microsoft/tui-test');

const child = spawn(process.execPath, [bin, ...process.argv.slice(2)], {
  cwd: e2eDir,
  stdio: 'inherit',
});
child.on('exit', (code) => process.exit(code ?? 1));
