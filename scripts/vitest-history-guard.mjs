/**
 * Vitest global setup — a read-only tripwire over the developer's real `~/.gsloth/history.db`.
 *
 * A spec that boots a real interactive session without stubbing the history recorder or the
 * session checkpointer writes a conversation row into that database on every unit run, and nothing
 * in the run says so: the suite stays green while the developer's own history fills with rows named
 * `test-model`. This fingerprints the file before the suite and fails the run in teardown, naming
 * the file, if the fingerprint changed.
 *
 * It never opens the database. It reads bytes, hashes them, and compares — nothing else — so it
 * cannot itself be the writer it guards against. When the file is absent it does nothing. Node's
 * own modules only, so it loads before any workspace package is built.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const dbPath = join(homedir(), '.gsloth', 'history.db');
/** SQLite can land a write in the write-ahead log before the main file moves, so it is watched too. */
const watched = [dbPath, `${dbPath}-wal`];

function fingerprint(file) {
  if (!existsSync(file)) return 'absent';
  const md5 = createHash('md5').update(readFileSync(file)).digest('hex');
  return `md5 ${md5} size ${statSync(file).size}`;
}

let before = null;

export function setup() {
  before = existsSync(dbPath) ? watched.map(fingerprint) : null;
}

export function teardown() {
  if (before === null) return;
  const after = watched.map(fingerprint);
  const changed = watched.filter((_, i) => before[i] !== after[i]);
  if (changed.length === 0) return;
  const detail = changed.map((file, i) => {
    const at = watched.indexOf(file);
    return `${i === 0 ? '' : '\n'}  ${file}\n    before: ${before[at]}\n    after:  ${after[at]}`;
  });
  // Vitest only LOGS an error thrown from a global-setup teardown ("error during close") and then
  // exits through a bare process.exit(), which honours process.exitCode — so the code is set here,
  // or the run prints the finding and still exits 0. Measured on vitest 4.1.
  process.exitCode = 1;
  throw new Error(
    `The unit run changed the developer's real history database: ${dbPath}\n` +
      'A spec booted a real session without stubbing the history recorder ' +
      '(@gaunt-sloth/core/history/recordSession.js) or the session checkpointer ' +
      '(@gaunt-sloth/core/history/sessionCheckpointer.js). Stub both, the way the ' +
      'interactive-session specs do.\n' +
      detail.join('')
  );
}
