/**
 * BATCH-58 — the template tokens of a `command` case's `workspace`: what `{{…}}` may name inside an
 * `env` value or a `setup` argument, checked at parse time and expanded at run time.
 *
 * | token                | expands to                                                          |
 * |----------------------|---------------------------------------------------------------------|
 * | `{{suite_dir}}`      | the directory of the suite file, absolute                           |
 * | `{{workspace}}`      | the case's workspace directory, absolute                            |
 * | `{{env.NAME}}`       | `NAME` in the environment gth was started with, or empty when unset |
 * | `{{path_delimiter}}` | `path.delimiter`: `:` on POSIX, `;` on Windows                      |
 *
 * ## Why expansion happens after the split, never before
 *
 * A `setup` step is split into argv by `commandArgv.ts` at parse time, and each argv ELEMENT is
 * expanded at run time. An expanded value therefore stays inside the one argument it was written in:
 * a `{{workspace}}` under a directory with a space in its name, or an `{{env.X}}` holding
 * `a; rm -rf ~`, is one argument, never two and never a command. Expanding first and splitting
 * second would make the values of the environment part of the command line's grammar.
 *
 * ## Why an unknown token is a parse error
 *
 * Nothing else in a suite is allowed to be silently ignored (BATCH-56), and a misspelt
 * `{{suite-dir}}` left in place would reach the agent as a literal path that does not exist, which
 * reads as the agent's failure.
 *
 * ## Why a stray `{{` or `}}` in a `setup` argument is a parse error too
 *
 * A token is only recognised inside ONE `setup` argument, because expansion runs after the split.
 * Whitespace inside the braces is trimmed, so `"{{ workspace }}"` QUOTED is one argument and
 * expands; unquoted, `{{ workspace }}` is split into `{{`, `workspace` and `}}`, none of which is a
 * token, and the step would receive those three literals. So in a `setup` argument any `{{` or `}}`
 * left over once the complete tokens are taken out ({@link findStrayTokenBrace}) is refused at
 * parse. An `env` value is never split, so it cannot lose a token that way, and a stray brace in
 * one (compact JSON such as `{"a":{"b":1}}`) passes through literally. Single braces are always
 * ordinary text. {@link expandWorkspaceTemplate} itself leaves stray braces alone; the parser is
 * what refuses them.
 *
 * `{{path_delimiter}}` exists because `PATH` composition differs per platform: a suite that writes
 * `{{suite_dir}}/stubs{{path_delimiter}}{{env.PATH}}` works on every OS, where a literal `:` breaks
 * Windows.
 *
 * @module
 */
import { delimiter } from 'node:path';

const TOKEN_RE = /\{\{([^{}]*)\}\}/g;
const ENV_TOKEN_RE = /^env\.(\S+)$/;

/** The values the tokens expand to for one case. */
export interface WorkspaceTemplateValues {
  suiteDir: string;
  workspace: string;
  /** Reads one inherited environment variable; `undefined` when unset. */
  readEnv: (name: string) => string | undefined;
}

/** The token names, for messages. */
export const WORKSPACE_TEMPLATE_TOKENS = [
  '{{suite_dir}}',
  '{{workspace}}',
  '{{env.NAME}}',
  '{{path_delimiter}}',
] as const;

function classify(
  inner: string
): { kind: 'suite_dir' | 'workspace' | 'path_delimiter' } | { kind: 'env'; name: string } | null {
  const name = inner.trim();
  if (name === 'suite_dir' || name === 'workspace' || name === 'path_delimiter') {
    return { kind: name };
  }
  const env = ENV_TOKEN_RE.exec(name);
  return env ? { kind: 'env', name: env[1] } : null;
}

/**
 * The first unknown token in `text`, as written (`{{suite-dir}}`), or `undefined` when every token
 * is known.
 */
export function findUnknownWorkspaceToken(text: string): string | undefined {
  for (const match of text.matchAll(TOKEN_RE)) {
    if (classify(match[1]) === null) return match[0];
  }
  return undefined;
}

/**
 * A `{{` or `}}` in `text` that is not part of a complete `{{…}}` token, or `undefined` when there
 * is none. A complete token, known or not, is {@link findUnknownWorkspaceToken}'s business.
 */
export function findStrayTokenBrace(text: string): '{{' | '}}' | undefined {
  const rest = text.replace(TOKEN_RE, '');
  if (rest.includes('{{')) return '{{';
  if (rest.includes('}}')) return '}}';
  return undefined;
}

/** Whether `text` holds a complete `{{…}}` token of any name. */
export function containsWorkspaceToken(text: string): boolean {
  return new RegExp(TOKEN_RE.source).test(text);
}

/**
 * Expand every token in `text`. A token the parser would have rejected throws, so a caller that
 * skipped the parse check cannot pass one through as a literal.
 */
export function expandWorkspaceTemplate(text: string, values: WorkspaceTemplateValues): string {
  return text.replace(TOKEN_RE, (whole, inner: string) => {
    const token = classify(inner);
    if (token === null) throw new Error(`unknown workspace token ${whole}`);
    switch (token.kind) {
      case 'suite_dir':
        return values.suiteDir;
      case 'workspace':
        return values.workspace;
      case 'path_delimiter':
        return delimiter;
      case 'env':
        return values.readEnv(token.name) ?? '';
    }
  });
}
