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
//
// BATCH-58 workspace modes. Each answers with a one-line `result` transcript; the trailing argument
// is the case's prompt.
//   fake-cli.mjs edit-shared <barrierdir> <file> <prompt>
//                                                  append the prompt as a line to <file> in the cwd,
//                                                  meeting the other case at a barrier before and
//                                                  after, then answer with the file's content
//   fake-cli.mjs call-stub <name> <prompt>         run the first <name>.mjs on PATH with node,
//                                                  passing the prompt, and answer with its stdout
//   fake-cli.mjs cwd <prompt>                      answer with the working directory
//   fake-cli.mjs cat <file> <prompt>               answer with <file>'s content
//   fake-cli.mjs env-var <name> <prompt>           answer with the variable's value
//   fake-cli.mjs write <file> <content>            write <content> to <file> (a setup step)
//   fake-cli.mjs argv-dump <file> [args...]        write its arguments and GTH_B58_SETUP_MARK to
//                                                  <file> as JSON (a setup step)
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';

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

function answer(text) {
  process.stdout.write(
    JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: text }) + '\n'
  );
}

// Wait until `count` files ending in `.<stage>` exist in `dir`, having added our own. Bounded, so
// a case that never meets its partner still finishes; giving up writes `<me>.<stage>.timedout`, so
// the spec can tell a real meeting from a wait that ran out.
async function barrier(dir, me, stage, count) {
  writeFileSync(join(dir, `${me}.${stage}`), '');
  for (let i = 0; i < 200; i += 1) {
    if (readdirSync(dir).filter((f) => f.endsWith(`.${stage}`)).length >= count) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  writeFileSync(join(dir, `${me}.${stage}.timedout`), '');
}

if (mode === 'edit-shared') {
  const [barrierDir, file, prompt] = rest;
  await barrier(barrierDir, prompt, 'ready', 2);
  appendFileSync(file, `${prompt}\n`);
  await barrier(barrierDir, prompt, 'written', 2);
  answer(readFileSync(file, 'utf8'));
} else if (mode === 'call-stub') {
  const [name, prompt] = rest;
  const dir = (process.env.PATH ?? '')
    .split(delimiter)
    .find((entry) => entry && existsSync(join(entry, `${name}.mjs`)));
  if (dir === undefined) {
    answer(`no ${name}.mjs on PATH`);
  } else {
    const ran = spawnSync(process.execPath, [join(dir, `${name}.mjs`), prompt], {
      encoding: 'utf8',
    });
    answer(ran.stdout.trim());
  }
} else if (mode === 'cwd') {
  answer(process.cwd());
} else if (mode === 'cat') {
  answer(readFileSync(rest[0], 'utf8'));
} else if (mode === 'env-var') {
  answer(process.env[rest[0]] ?? '(unset)');
} else if (mode === 'write') {
  writeFileSync(rest[0], rest[1]);
} else if (mode === 'argv-dump') {
  // A setup step that records what it was given: every argument after <file>, and the marker
  // variable, written to <file> (relative paths land in the step's cwd).
  const [file, ...args] = rest;
  writeFileSync(file, JSON.stringify({ args, mark: process.env.GTH_B58_SETUP_MARK ?? null }));
} else if (mode === 'replay') {
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
