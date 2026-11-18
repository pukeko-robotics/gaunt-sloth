// A stand-in for a command-line agent, for the `command` eval target's specs (BATCH-57). It never
// calls a model: it replays a captured transcript, or misbehaves on purpose.
//
//   fake-cli.mjs replay <transcript>               print the transcript, exit 0
//   fake-cli.mjs exit <code> <transcript>          print the transcript and some stderr, exit <code>
//   fake-cli.mjs drain-stdin <transcript>          read stdin to its end, then replay
//   fake-cli.mjs garbage                          print text that is not a transcript, exit 0
//   fake-cli.mjs hang <pidfile>                    start a grandchild, write its pid, never exit
//   fake-cli.mjs hang-holding-pipes <pidfile>      the same, but the grandchild leads its own
//                                                  process group and holds stdout/stderr open
//   fake-cli.mjs record <outfile> <transcript> [prompt]
//                                                  write the prompt it received (the trailing
//                                                  argument, else stdin) to <outfile>, then replay
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const [mode, ...rest] = process.argv.slice(2);

function replay(file) {
  process.stdout.write(readFileSync(file, 'utf8'));
}

function readStdin() {
  return new Promise((resolve) => {
    const chunks = [];
    process.stdin.on('data', (chunk) => chunks.push(chunk));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

if (mode === 'replay') {
  replay(rest[0]);
} else if (mode === 'exit') {
  replay(rest[1]);
  process.stderr.write('fake-cli: failing on purpose\n');
  process.exitCode = Number(rest[0]);
} else if (mode === 'drain-stdin') {
  // Read stdin to its end before replaying: an open, never-closed pipe would hang here.
  await readStdin();
  replay(rest[0]);
} else if (mode === 'garbage') {
  process.stdout.write('this is not a transcript\n{"type":"assistant"\n');
} else if (mode === 'hang') {
  const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
  });
  // Our own pid first, so a reader that finds the grandchild's file can rely on this one.
  writeFileSync(`${rest[0]}.self`, String(process.pid));
  writeFileSync(rest[0], String(grandchild.pid));
  setInterval(() => {}, 1000);
} else if (mode === 'hang-holding-pipes') {
  // A grandchild in its OWN process group that inherits our stdout and stderr: the tree kill's
  // negative pid does not reach it, it keeps the pipes open, and the runner never sees 'close'.
  const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: ['ignore', 'inherit', 'inherit'],
    detached: true,
  });
  grandchild.unref();
  writeFileSync(rest[0], String(grandchild.pid));
  setInterval(() => {}, 1000);
} else if (mode === 'record') {
  const [outfile, transcript, promptArg] = rest;
  const prompt = rest.length >= 3 ? promptArg : await readStdin();
  writeFileSync(outfile, prompt, 'utf8');
  replay(transcript);
} else {
  process.stderr.write(`fake-cli: unknown mode ${mode}\n`);
  process.exitCode = 64;
}
