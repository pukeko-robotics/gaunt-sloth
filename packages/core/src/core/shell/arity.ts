/**
 * @module core/shell/arity
 *
 * EXT-9 Tier-2 ergonomics: classify a shell command into a stable, human-readable
 * **prefix** (binary + N meaningful subcommands) so an approval the human grants once
 * (`git checkout main`) can be remembered as a pattern (`git checkout *`) and matched
 * against later flag-variants (`git checkout -b foo bar`) WITHOUT re-prompting.
 *
 * The arity table (which tokens past the binary are "meaningful subcommands" rather
 * than operands/flags) is a port of a subset of opencode's ~160-command table
 * (`opencode/packages/opencode/src/permission/arity.ts`). Binaries not in the table
 * default to arity 0 = just the binary.
 *
 * SECURITY — this is the anti-injection core. {@link classifyCommand} returns `null`
 * (fail-closed) whenever the command contains shell composition that could change the
 * target of the operation: separators (`;`, `&&`, `||`, `|`, `&`), newlines, command
 * substitution (`$(...)`, backticks), process substitution (`<(...)`/`>(...)`), or
 * redirections. Such commands NEVER auto-match an allow-list entry — they always go to
 * fresh human approval. This is what stops `git checkout x; rm -rf /` from matching an
 * approved `git checkout *`.
 */

/**
 * Arity table: command-prefix string → number of leading tokens (binary + subcommands,
 * flags excluded) that define the "human-understandable command". Longest matching
 * prefix wins. Ported subset of opencode's table — git/npm/pnpm/yarn/docker/kubectl/
 * cargo/go/etc. Binaries absent here default to arity 0 (just the binary), see
 * {@link arityFor}.
 *
 * Rule (from opencode): flags never count as tokens; only subcommands do. Include a
 * longer prefix only when its arity differs from what the shorter prefix implies.
 */
const ARITY: Readonly<Record<string, number>> = {
  // Single-token utilities (arity 1 = just the binary; here for completeness/clarity).
  cat: 1,
  cd: 1,
  chmod: 1,
  chown: 1,
  cp: 1,
  echo: 1,
  env: 1,
  export: 1,
  grep: 1,
  kill: 1,
  killall: 1,
  ln: 1,
  ls: 1,
  mkdir: 1,
  mv: 1,
  ps: 1,
  pwd: 1,
  rm: 1,
  rmdir: 1,
  sleep: 1,
  source: 1,
  tail: 1,
  head: 1,
  touch: 1,
  unset: 1,
  which: 1,
  find: 1,
  // Cloud / infra CLIs.
  aws: 3,
  az: 3,
  bazel: 2,
  brew: 2,
  bun: 2,
  'bun run': 3,
  'bun x': 3,
  cargo: 2,
  'cargo add': 3,
  'cargo run': 3,
  cdk: 2,
  cf: 2,
  cmake: 2,
  composer: 2,
  consul: 2,
  'consul kv': 3,
  crictl: 2,
  deno: 2,
  'deno task': 3,
  doctl: 3,
  docker: 2,
  'docker builder': 3,
  'docker compose': 3,
  'docker container': 3,
  'docker image': 3,
  'docker network': 3,
  'docker volume': 3,
  eksctl: 2,
  'eksctl create': 3,
  firebase: 2,
  flyctl: 2,
  gcloud: 3,
  gh: 3,
  git: 2,
  'git config': 3,
  'git remote': 3,
  'git stash': 3,
  go: 2,
  gradle: 2,
  helm: 2,
  heroku: 2,
  hugo: 2,
  ip: 2,
  'ip addr': 3,
  'ip link': 3,
  'ip netns': 3,
  'ip route': 3,
  kind: 2,
  'kind create': 3,
  kubectl: 2,
  'kubectl kustomize': 3,
  'kubectl rollout': 3,
  kustomize: 2,
  make: 2,
  mc: 2,
  'mc admin': 3,
  minikube: 2,
  mongosh: 2,
  mysql: 2,
  mvn: 2,
  ng: 2,
  npm: 2,
  'npm exec': 3,
  'npm init': 3,
  'npm run': 3,
  'npm view': 3,
  npx: 2,
  nvm: 2,
  nx: 2,
  openssl: 2,
  'openssl req': 3,
  'openssl x509': 3,
  pip: 2,
  pipenv: 2,
  pnpm: 2,
  'pnpm dlx': 3,
  'pnpm exec': 3,
  'pnpm run': 3,
  poetry: 2,
  podman: 2,
  'podman container': 3,
  'podman image': 3,
  psql: 2,
  pulumi: 2,
  'pulumi stack': 3,
  pyenv: 2,
  python: 2,
  python3: 2,
  rake: 2,
  rbenv: 2,
  'redis-cli': 2,
  rustup: 2,
  serverless: 2,
  sfdx: 3,
  skaffold: 2,
  sls: 2,
  sst: 2,
  swift: 2,
  systemctl: 2,
  terraform: 2,
  'terraform workspace': 3,
  tmux: 2,
  turbo: 2,
  ufw: 2,
  vault: 2,
  'vault auth': 3,
  'vault kv': 3,
  vercel: 2,
  volta: 2,
  wp: 2,
  yarn: 2,
  'yarn dlx': 3,
  'yarn run': 3,
};

/**
 * Result of classifying a command for allow-list matching.
 */
export interface CommandClassification {
  /**
   * The meaningful command prefix — binary plus subcommands per the arity table, with
   * flags removed. This is the allow-list KEY: two commands with the same prefix are the
   * "same operation" for approval purposes (`git checkout main` and `git checkout -b x`
   * both → `git checkout`).
   */
  prefix: string;
  /**
   * Human-facing display pattern, e.g. `git checkout *` (or `ls *`). The trailing `*`
   * signals "any args/flags". A prefix that already consumed the whole command (no extra
   * operands) still gets ` *` for a consistent, honest "future args allowed" affordance.
   */
  pattern: string;
}

/**
 * Tokens / sequences whose presence means the command composes or redirects in a way that
 * could change what actually runs — so it must NOT be classifiable for auto-match. Checked
 * against the NORMALIZED command (see normalize.ts) which has already collapsed obfuscation.
 *
 * Note: `&&`/`||`/`|` are covered by the bare `&`/`|` character scan; listed conceptually.
 */
function hasUnsafeComposition(normalized: string): boolean {
  // Newlines are folded by normalizeCommand, but guard anyway in case a raw string is passed.
  if (/[\n\r]/.test(normalized)) return true;
  // Shell control / separator operators and background.
  if (/[;|&]/.test(normalized)) return true;
  // Command substitution: $(...) or `...`.
  if (/\$\(/.test(normalized)) return true;
  if (/`/.test(normalized)) return true;
  // Variable/arith expansion that could inject: ${...} and $((...)).
  if (/\$\{/.test(normalized)) return true;
  // Process substitution: <(...) or >(...).
  if (/[<>]\(/.test(normalized)) return true;
  // Redirections (any < or > not already caught as process substitution): >, >>, <, 2>, &>.
  if (/[<>]/.test(normalized)) return true;
  return false;
}

/**
 * Tokenize a shell command into argv, honoring single and double quotes. Quotes group
 * (and are stripped from) a token; backslash-escaping inside double quotes is collapsed
 * by the prior normalize step, so this tokenizer treats a residual `\` literally.
 *
 * This is a deliberately small tokenizer used ONLY for prefix detection — never for
 * execution. The original command string is what runs.
 *
 * Returns `null` if quoting is unbalanced (an open quote with no close), which is itself
 * a reason to refuse classification (ambiguous parse → fail-closed).
 */
export function tokenize(command: string): string[] | null {
  const tokens: string[] = [];
  let current = '';
  let inToken = false;
  let quote: '"' | "'" | null = null;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      inToken = true;
      continue;
    }
    if (ch === ' ' || ch === '\t') {
      if (inToken) {
        tokens.push(current);
        current = '';
        inToken = false;
      }
      continue;
    }
    current += ch;
    inToken = true;
  }
  if (quote) return null; // unbalanced quote
  if (inToken) tokens.push(current);
  return tokens;
}

/**
 * Look up the arity (number of leading meaningful tokens) for an argv, using the
 * longest-matching-prefix rule against {@link ARITY}. Flag tokens (starting with `-`) are
 * dropped when forming the candidate prefixes so boolean flags like `git --no-pager
 * checkout` still resolve `git checkout`. Unknown binaries default to arity 0 → just the
 * binary.
 *
 * LIMITATION (intentional, fail-closed): we do NOT maintain a per-flag arity table, so an
 * arg-taking flag leaves its operand in the non-flag stream (e.g. `git -C . checkout` →
 * `git .`). That simply fails to match an approved `git checkout` and re-prompts — safe, by
 * design — rather than risking a mis-classification that mis-approves.
 *
 * Returns the list of meaningful tokens (binary + subcommands), flag tokens excluded.
 */
export function meaningfulPrefixTokens(argv: string[]): string[] {
  // Drop leading flags before the binary cannot happen (binary is first), but a binary
  // can be followed by flags interleaved with subcommands (e.g. `git -C . checkout`).
  // Build the flag-free token sequence first, preserving order.
  const nonFlag = argv.filter((t) => !t.startsWith('-'));
  if (nonFlag.length === 0) return [];

  // Longest matching prefix in the arity table wins.
  for (let len = nonFlag.length; len > 0; len--) {
    const candidate = nonFlag.slice(0, len).join(' ');
    const arity = ARITY[candidate];
    if (arity !== undefined) {
      // arity counts meaningful tokens from the start of the non-flag sequence.
      return nonFlag.slice(0, Math.min(arity, nonFlag.length));
    }
  }
  // Not in the table → arity 0 means "just the binary".
  return nonFlag.slice(0, 1);
}

/**
 * Classify a command into a stable allow-list prefix + display pattern, or `null` when it
 * cannot be safely classified for matching (composition/redirection/substitution present,
 * empty, or unbalanced quotes).
 *
 * @param command Raw command string as the model proposed it.
 * @param normalize Normalizer to apply for the detection form (inject normalizeCommand).
 */
export function classifyCommand(
  command: string,
  normalize: (cmd: string) => string
): CommandClassification | null {
  const normalized = normalize(command);
  if (!normalized) return null;

  // FAIL-CLOSED on any composition/redirection/substitution. This is the anti-injection
  // guarantee: such commands never auto-match an allow-list entry.
  if (hasUnsafeComposition(normalized)) return null;

  const argv = tokenize(normalized);
  if (!argv || argv.length === 0) return null;

  const prefixTokens = meaningfulPrefixTokens(argv);
  if (prefixTokens.length === 0) return null;

  const prefix = prefixTokens.join(' ');
  return { prefix, pattern: `${prefix} *` };
}
