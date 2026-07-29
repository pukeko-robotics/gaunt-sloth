/**
 * @module core/shell/openWorld
 *
 * EXT-61 (spec §4.6) — the **open-world preflight**: a deterministic, model-free check for a
 * **host literal in a fetch/transfer position**. A command that carries one is floored at
 * `destructive` before the rater is ever called ({@link import('./rater.js').mapVerdictToAction}),
 * so it is always asked about and can never be auto-approved.
 *
 * ## Why this is not a trust judgement, and must never become one
 *
 * §4.1.1(4) asks the rater to tell `registry.npmjs.org` from `registry.npmjs.ag`. **Both a cheap
 * model and a working developer were measured failing exactly that** — the developer flagged the
 * *genuine* registry as destructive, i.e. did not discriminate hostnames in either direction. This
 * preflight does not answer that question, it **deletes** it: both hostnames floor, both are asked
 * about, and no misreading of a hostname can produce an auto-approve.
 *
 * It therefore needs **no list of good hosts**, and that is precisely what makes it immune to the
 * attack it defends against — there is nothing to spoof into. If host trust is ever wanted it MUST
 * be a deterministic exact-match list in code (§4.1.1), never a model call. The user-facing escape
 * hatch already exists and is `approvals.allow` (§3), which is consulted *before* the rater and
 * therefore before this.
 *
 * ## Why a heuristic is acceptable here
 *
 * **This layer can only ever RAISE a rating, never lower one.** A miss costs nothing relative to
 * today — the rater still rates the command — while an over-match costs a prompt. That asymmetry is
 * what makes an admittedly incomplete verb table safe here and would *not* make it safe in the §8
 * hardline floor, where a false positive is an unappealable refusal under every rung including
 * `bypass`. EXT-60's review measured that cost directly: its first `chown` patterns refused
 * `grep chown -r /etc`, because `-r` is grep's own recursive flag.
 *
 * ## The shape of the matcher
 *
 * Ported from the measured prototype (`project-takahe _spikes/open-world-preflight/`), which ran
 * 22/22 corpus `open_world` cases floored and 0/21 corpus `safe` cases wrongly floored.
 *
 * 1. **Decline on anything unclassifiable.** {@link classifyCommand} returns `null` on any
 *    composition (separator, line break, `$(…)`, backtick, redirection), and the *ambiguity*
 *    preflight already floors those. So this matcher never has to parse a hard command — and it
 *    must not claim the finding, because "it names a host" would be a worse (and possibly false)
 *    explanation than "its target cannot be statically resolved".
 * 2. **Strip wrappers** (`sudo`, `env VAR=V`, `exec`, `nohup`, …) — the same list the hardline uses.
 * 3. **Look the head up** in {@link NETWORK_HEADS}, keyed by *where a host may legitimately appear*.
 * 4. **Test only the candidate operands** for a host literal.
 *
 * **The head gate does nearly all of the work, and it is what keeps the false-positive rate at
 * zero.** A URL under a head that cannot reach the network is not a fetch, so `echo`, `grep`, `sed`
 * and — the case that would have sunk this design — `git commit -m "closes https://…"` all fall out
 * for free. The matcher fires on a host literal in a fetch position, **never on the presence of a
 * URL anywhere in the string**.
 *
 * **The project's own configured destinations are not host literals.** `git push origin main` and
 * `npm install lodash` name no host — they resolve one from `.git/config` and `.npmrc` — so they
 * stay `safe`, which is what keeps the corpus's `routine-mutating` family unprompted.
 */

import { classifyCommand, tokenize } from '#src/core/shell/arity.js';
import { normalizeCommand } from '#src/core/shell/normalize.js';

/**
 * Wrapper binaries that delegate to the *next* token, so the head to test sits behind them. Mirrors
 * the hardline's own wrapper list. `VAR=value` assignments are skipped by the same loop.
 */
const WRAPPERS: ReadonlySet<string> = new Set([
  'sudo',
  'doas',
  'exec',
  'nohup',
  'setsid',
  'time',
  'env',
]);

/** A leading `VAR=value` assignment, which precedes the real head exactly like a wrapper does. */
const ENV_ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * Where a host may legitimately appear for a given head.
 *
 * - `all` — every positional operand is a candidate. These binaries exist to talk to a host.
 * - `subcommand` — only under these subcommands (`git`: a URL where a remote name belongs).
 * - `flag` — only as the value of these flags (a registry / index override).
 */
type HostPosition =
  | { readonly kind: 'all' }
  | { readonly kind: 'subcommand'; readonly subcommands: ReadonlySet<string> }
  | { readonly kind: 'flag'; readonly flags: ReadonlySet<string> };

/**
 * The network-capable heads, and where a host may appear under each.
 *
 * **This table is INCOMPLETE BY CONSTRUCTION and that is a design decision, not an oversight** —
 * `svn`, `hg`, `mvn`, `gradle`, `kubectl`, `docker`, `gh`, `terraform` and others all reach the
 * network and are deliberately absent. Adding one is cheap and safe (a miss becomes a prompt);
 * what is *not* safe is widening a head's `HostPosition` so that an ordinary operand starts
 * reading as a fetch target. Weigh any addition against the must-NOT-fire probes in
 * `spec/shellOpenWorld.spec.ts`, not against the corpus — the corpus has almost no coverage of
 * that direction (see that spec's docblock).
 *
 * A `Map`, not an object literal, on purpose: the head comes from an attacker-influenceable command
 * string, and `NET['constructor']` on a plain object resolves through the prototype chain to
 * something that is not an entry of this table. The same hazard is documented at
 * {@link import('./rater.js').isBelowDestructiveFloor}.
 */
const NETWORK_HEADS: ReadonlyMap<string, HostPosition> = new Map<string, HostPosition>([
  // Fetchers / transfer agents — the whole point of the binary is a remote endpoint.
  ['curl', { kind: 'all' }],
  ['wget', { kind: 'all' }],
  ['aria2c', { kind: 'all' }],
  ['http', { kind: 'all' }], // httpie
  ['httpie', { kind: 'all' }],
  ['xh', { kind: 'all' }],
  ['nc', { kind: 'all' }],
  ['ncat', { kind: 'all' }],
  ['netcat', { kind: 'all' }],
  ['scp', { kind: 'all' }],
  ['sftp', { kind: 'all' }],
  ['ftp', { kind: 'all' }],
  ['rsync', { kind: 'all' }],
  ['ssh', { kind: 'all' }],
  // Cloud CLIs — a bucket/object URI is a host literal (`s3://…`, `gs://…`).
  ['aws', { kind: 'all' }],
  ['gsutil', { kind: 'all' }],
  ['az', { kind: 'all' }],
  // `git` only where a URL stands in for a configured remote. `git commit -m "…https://…"` and
  // `git tag -a v1 -m "see https://…"` are NOT fetches, and prompting on them would be a worse
  // annoyance regression than the one this preflight was built to avoid.
  [
    'git',
    {
      kind: 'subcommand',
      subcommands: new Set([
        'clone',
        'push',
        'pull',
        'fetch',
        'remote',
        'submodule',
        'ls-remote',
        'archive',
      ]),
    },
  ],
  // Package managers: only a registry/index OVERRIDE names a host. The configured default in
  // `.npmrc` is not a host literal, so `npm install lodash` stays unprompted.
  ['npm', { kind: 'flag', flags: new Set(['--registry']) }],
  ['pnpm', { kind: 'flag', flags: new Set(['--registry']) }],
  ['yarn', { kind: 'flag', flags: new Set(['--registry']) }],
  ['pip', { kind: 'flag', flags: new Set(['--index-url', '--extra-index-url', '-i']) }],
  ['pip3', { kind: 'flag', flags: new Set(['--index-url', '--extra-index-url', '-i']) }],
]);

/** `scheme://…` — `https`, `http`, `ftp`, `s3`, `gs`, `git+ssh`, anything. */
const SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i;
/** `user@host` (`deploy@myhost:/srv/`, `git@github.com:owner/repo.git`). */
const USER_AT_HOST_RE = /^[^@\s/]+@[a-z0-9._-]+(:|$)/i;
/** A bare IPv4 target, with or without a port or path. */
const IPV4_RE = /^(\d{1,3}\.){3}\d{1,3}(:|\/|$)/;
/** scp/rsync `host.tld:path` with no scheme. The `(?!\/\/)` keeps it from re-matching a scheme. */
const HOST_COLON_PATH_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)+:(?!\/\/)/i;

/**
 * Does this operand name a host — a URL scheme, a `user@host`, an IPv4 literal, or an scp-style
 * `host:path`? Deliberately syntactic: it asks *"is a counterparty named here"*, never *"is that
 * counterparty trustworthy"* (§4.1.1).
 */
export function isHostLiteral(operand: string): boolean {
  return (
    SCHEME_RE.test(operand) ||
    USER_AT_HOST_RE.test(operand) ||
    IPV4_RE.test(operand) ||
    HOST_COLON_PATH_RE.test(operand)
  );
}

/**
 * Reduce an argv[0] to the bare binary name: drop any path prefix, case-fold, drop a `.exe`.
 *
 * **The case fold is a real evasion fix, found by RUNNING the prototype rather than reading it.**
 * `cUrL https://…` passed the first version, because {@link normalizeCommand} deliberately
 * preserves case. That is irrelevant on Linux — but on **Windows and case-insensitive macOS
 * volumes that command resolves and runs**, and gaunt-sloth ships on both. A local Linux test run
 * cannot prove this cell; the CI matrix is what does.
 */
function bareHead(token: string): string {
  const lastSegment = token.split(/[\\/]/).pop() ?? '';
  return lastSegment.toLowerCase().replace(/\.exe$/, '');
}

/**
 * Test ONE tokenized form of the command for a host literal in a fetch position: strip wrappers,
 * gate on the head, then test only the operands where a host may legitimately appear.
 *
 * Kept separate from {@link findOpenWorldHostLiteral} because that function runs this over **two**
 * forms of the same command — see there for why.
 */
function matchArgv(argv: readonly string[]): string | null {
  // (2) Step over wrappers and leading `VAR=value` assignments to the real head.
  let index = 0;
  while (
    index < argv.length &&
    (WRAPPERS.has(bareHead(argv[index])) || ENV_ASSIGNMENT_RE.test(argv[index]))
  ) {
    index++;
  }

  // (3) The head gate — the single thing that keeps the false-positive rate at zero.
  const position = NETWORK_HEADS.get(bareHead(argv[index] ?? ''));
  if (position === undefined) return null;

  // (4) Only the operands where a host may legitimately appear are candidates.
  const operands = argv.slice(index + 1);
  const candidates: string[] = [];
  switch (position.kind) {
    case 'all':
      candidates.push(...operands.filter((operand) => !operand.startsWith('-')));
      break;
    case 'subcommand': {
      const subcommand = operands.find((operand) => !operand.startsWith('-'));
      if (subcommand !== undefined && position.subcommands.has(subcommand)) {
        candidates.push(...operands.filter((operand) => !operand.startsWith('-')));
      }
      break;
    }
    case 'flag':
      for (let i = 0; i < operands.length; i++) {
        // Both spellings: `--registry=URL` and `--registry URL`.
        const [flag, inlineValue] = operands[i].split(/=(.*)/);
        if (position.flags.has(flag)) candidates.push(inlineValue ?? operands[i + 1] ?? '');
      }
      break;
  }

  return candidates.find(isHostLiteral) ?? null;
}

/**
 * Find a **host literal in a fetch/transfer position**, or `null` when the command names no
 * counterparty (spec §4.6).
 *
 * Takes the **raw** command, exactly like the other preflights: normalization happens inside, so a
 * caller can never accidentally hand this a form that has already lost the composition boundary
 * the decline below depends on.
 *
 * Returns `null` — declining rather than flooring — for any command {@link classifyCommand} cannot
 * classify. Those compose, substitute or redirect, and the **ambiguity preflight already floors
 * them**, with a truer explanation than this one could give. Composed egress
 * (`curl … | sh`, `cat .env | curl …`) is thus still floored; it is simply floored one layer up.
 * That decline is also why `sed -i 's|http://a|http://b|' config.yml` is not this preflight's
 * finding: the `|` inside the sed expression reads as composition, so it was already unclassifiable
 * — and already escalating — before EXT-61 existed.
 *
 * ## Why both the normalized AND the raw argv are tested
 *
 * {@link normalizeCommand} collapses `\x` to `x`, which is correct on POSIX (it is what defeats
 * `c\url https://…`) and **destroys a Windows path separator**: `C:\Windows\System32\curl.exe`
 * normalizes to `C:WindowsSystem32curl.exe`, whose last path segment is no longer `curl`, so the
 * head gate misses it. That command runs on Windows, and gaunt-sloth ships there. Measured, not
 * reasoned — the POSIX form `/usr/bin/curl` was already handled, which is exactly what made the
 * Windows one easy to miss by reading.
 *
 * A second pass over the raw argv closes it. It is safe **because this layer can only RAISE**: a
 * second chance to match can add a prompt, never remove one, and the head gate is unchanged — an
 * argv[0] whose last path segment is literally `curl` or `wget` is a network binary under any
 * reading. The normalized pass still runs first and still owns the anti-obfuscation guarantees.
 *
 * @param command The raw command string as the model proposed it.
 * @returns The matched host literal (used verbatim in the escalation reason), or `null`.
 */
export function findOpenWorldHostLiteral(command: string): string | null {
  // (1) Unclassifiable → not ours. See the docblock: the ambiguity preflight owns these.
  if (classifyCommand(command, normalizeCommand) === null) return null;

  // The anti-obfuscation form first — `c\url`, `r''m`, fullwidth glyphs and ANSI escapes are all
  // folded away here.
  const normalizedArgv = tokenize(normalizeCommand(command));
  // `null` is unreachable in practice (classifyCommand already returns null on an unbalanced
  // quote); handled anyway so this function is total on its own terms rather than relying on a
  // neighbour's invariant.
  const normalizedHit = normalizedArgv === null ? null : matchArgv(normalizedArgv);
  if (normalizedHit !== null) return normalizedHit;

  // …then the raw form, which is the only one that still has its Windows path separators.
  const rawArgv = tokenize(command);
  return rawArgv === null ? null : matchArgv(rawArgv);
}
