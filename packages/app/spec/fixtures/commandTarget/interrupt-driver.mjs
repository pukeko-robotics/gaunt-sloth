// Stands in for an interrupted `gth eval` (BATCH-57): starts a command through the BUILT runner,
// waits until the command and its grandchild are running, then ends this process the way core's
// SIGINT handler does.
//
//   interrupt-driver.mjs <built commandEvalRunner.js> <fake-cli.mjs> <pidfile>
//
// On POSIX it sends itself SIGINT, so core's real handler (installed by importing the runner, which
// imports systemUtils) runs and calls process.exit(0). Windows cannot deliver a catchable SIGINT to
// a process from code, so there it calls process.exit(0) directly, which is where that handler
// ends. Either way the runner's 'exit' listener is what must stop the children.
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const [runnerPath, fakeCli, pidFile] = process.argv.slice(2);
const { runCommandProcess } = await import(pathToFileURL(runnerPath).href);

void runCommandProcess({
  argv: [process.execPath, fakeCli, 'hang', pidFile],
  prompt: 'anything',
  promptDelivery: 'arg',
  timeoutMs: 120_000,
  cwd: process.cwd(),
  env: process.env,
});

const deadline = Date.now() + 15_000;
const poll = setInterval(() => {
  if (existsSync(pidFile)) {
    clearInterval(poll);
    if (process.platform === 'win32') process.exit(0);
    else process.kill(process.pid, 'SIGINT');
  } else if (Date.now() > deadline) {
    clearInterval(poll);
    process.stderr.write('interrupt-driver: the command never started\n');
    process.exit(3);
  }
}, 50);
