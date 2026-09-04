/**
 * @packageDocumentation
 * The one comparison of two workspace paths, shared by ACP's `session/new` (is this the project the
 * client already has an agent for?) and GS2-20's resume (was this conversation recorded in the
 * directory the session is running in?). One function, so the two cannot come to disagree about
 * which directories are the same directory.
 */

/**
 * Whether two already-resolved absolute paths name the same workspace.
 *
 * **Case-insensitive on win32 and nowhere else**, because that is where the answer differs: NTFS is
 * case-insensitive and case-preserving, so `C:\Foo` and `c:\foo` are one directory and an exact
 * string compare calls them two — a client that re-sends its own `cwd` with different casing would
 * be told to start a second agent process for the project it is already in, and a conversation
 * recorded under one spelling would be refused under the other. On POSIX the two really are
 * different directories and must keep comparing unequal, so the platform is the whole distinction
 * rather than a workaround for one.
 *
 * `platform` is a parameter with the live value as its default so both arms are testable on any
 * host. Every other bug of this shape in this repo (OPS-27, EXT-38, GS2-42, EXT-16) was a POSIX-only
 * assertion that passed everywhere except the Windows cell, and a test that can only run on win32
 * would have the same blind spot pointed the other way.
 */
export function isSameWorkspace(
  a: string,
  b: string,
  platform: NodeJS.Platform = process.platform
): boolean {
  return platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}
