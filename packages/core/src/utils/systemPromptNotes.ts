/**
 * Shared code-mode system-prompt augmentations (GS2-27).
 *
 * These notes describe capabilities that are IDENTICAL across both agent backends — the lean
 * {@link import('#src/core/GthLangChainAgent.js').GthLangChainAgent} (`createAgent`, in core) and
 * the deep `GthDeepAgent` (`createDeepAgent`, in `@gaunt-sloth/agent`): both expose the opt-in
 * `run_shell_command` tool and both operate on the real filesystem cwd. They were originally
 * composed ONLY inside `GthDeepAgent.init()` (EXT-13/EXT-26), so the now-default lean backend never
 * received them — accidental deep-only drift of the same class GS2-21 fixed for the main prompt.
 *
 * They live here in core so BOTH backends compose from ONE source. `GthDeepAgent` re-exports them
 * for back-compat with existing importers. The deepagents virtual-fs-namespace notes
 * (`appendVirtualCwdNote` / `PATH_NAMESPACE_GUIDANCE` / the correction middleware) are NOT here:
 * they are genuinely deep-only (a deepagents artifact — lean never runs virtualMode) and stay in
 * `GthDeepAgent`.
 */

/**
 * EXT-26: the platform-agnostic tail shared by both {@link appendOsShellNote} branches.
 *
 * The recurring failure mode on non-POSIX hosts is not just wrong command NAMES but shell
 * REDIRECTION quoting: a grouped/multi-line `echo` redirect on cmd.exe reported success yet wrote
 * a 0-byte file. So on every platform we steer file creation/mutation to the built-in
 * `write_file`/`edit_file` tools (which never touch the shell's quoting) and keep each shell
 * command a single line. Kept short — this is prompt text an LLM reads, not documentation.
 */
export const OS_SHELL_GUIDANCE =
  'Prefer the built-in write_file / edit_file tools over shell echo/redirection to create or ' +
  'modify files: shell redirection quoting is unreliable and can silently write an empty ' +
  '(0-byte) file. Keep each run_shell_command a single line.';

/**
 * EXT-26: append an OS + shell-dialect note to the composed code-mode system prompt.
 *
 * The model was never told its host OS or which shell `run_shell_command` uses, so on
 * non-POSIX hosts it defaulted to POSIX idioms that fail (ran `ls` where cmd.exe has `dir`, a
 * multi-line echo-redirect that wrote 0 bytes, a PowerShell here-string, `python -c` multi-line).
 * This is ORTHOGONAL to the EXT-13/16/22 path-namespace notes: those say WHERE the model is (path
 * form); this says WHAT shell it speaks (dialect). Backend-agnostic — the lean backend also exposes
 * `run_shell_command`, so GS2-27 composes it in the shared path.
 *
 * The shell is derived from the SAME rule Node's `spawn(command, { shell: true })` uses — exactly
 * how `run_shell_command` spawns (GthDevToolkit spawn) — so on `win32` it is cmd.exe (via
 * `%ComSpec%`) and on POSIX it is `/bin/sh` (POSIX sh, NOT guaranteed bash). Computed from
 * `process.platform` at call time so the text is correct per host. Returns the note alone when
 * there is no base prompt. A single injection is authoritative (nothing in the base prompt
 * contradicts shell dialect), so unlike EXT-22 no correction middleware is needed.
 */
export function appendOsShellNote(systemPrompt: string | undefined): string {
  let note: string;
  if (process.platform === 'win32') {
    note =
      'Host operating system: Windows. `run_shell_command` runs in cmd.exe. Use native cmd ' +
      'syntax: `dir` (not `ls`), `type` (not `cat`), `copy` / `move` / `del`, `%VAR%` for ' +
      'environment variables, and backslash paths. Do NOT use POSIX-only idioms: no sh/bash ' +
      'heredocs (`<< EOF`), no here-strings (`<<<`), no multi-line quoted command blocks, and do ' +
      `not assume POSIX quoting. ${OS_SHELL_GUIDANCE}`;
  } else {
    const osName = process.platform === 'darwin' ? 'macOS' : 'Linux';
    note =
      `Host operating system: ${osName}. \`run_shell_command\` runs in /bin/sh (POSIX sh, not ` +
      'necessarily bash). Stick to POSIX sh syntax and avoid bash-only constructs such as ' +
      `here-strings (\`<<<\`) and \`[[ ]]\` tests. ${OS_SHELL_GUIDANCE}`;
  }
  return systemPrompt ? `${systemPrompt}\n\n${note}` : note;
}

/**
 * EXT-13 (part b): append a real-cwd / path-model note to the composed code-mode system prompt.
 *
 * Code mode runs in REAL-path mode, so the filesystem tools and `run_shell_command` share one
 * real-absolute-path namespace rooted at `cwd`. The shared `.gsloth.code.md` prompt already tells
 * the model "the current working directory is provided to you separately"; this note is what
 * provides it — without it the model assumes `/` is cwd and hands `/`-rooted paths to the real-fs
 * shell. The cwd is injected dynamically (never baked into the .md). Backend-agnostic — the lean
 * backend also runs real-fs code sessions and previously received NO cwd value, so GS2-27 composes
 * it in the shared path. Returns the note alone when there is no base prompt.
 */
export function appendCwdNote(systemPrompt: string | undefined, cwd: string): string {
  const cwdNote =
    `Working directory: ${cwd}\n` +
    'Paths are real absolute filesystem paths (there is no virtual root). The working directory ' +
    'above is where this session runs; relative paths resolve against it, and both the filesystem ' +
    'tools and run_shell_command operate on these same real paths. Check the current directory ' +
    'before filesystem operations and prefer absolute paths (or paths relative to the working ' +
    'directory); do not assume the current directory is "/".';
  return systemPrompt ? `${systemPrompt}\n\n${cwdNote}` : cwdNote;
}
