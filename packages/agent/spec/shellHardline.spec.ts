import { describe, expect, it } from 'vitest';
import { checkHardline } from '#src/tools/shell/hardline.js';

describe('checkHardline', () => {
  const blocked = [
    'rm -rf /',
    'rm -rf /*',
    'rm -fr /',
    'rm -rf ~',
    'rm -rf $HOME',
    'rm -rf /etc',
    'rm -rf /usr/*',
    'sudo rm -rf /',
    'mkfs.ext4 /dev/sda1',
    'mkfs /dev/sdb',
    'dd if=/dev/zero of=/dev/sda',
    'echo x > /dev/sda',
    ':(){ :|:& };:',
    'shutdown -h now',
    'sudo reboot',
    'poweroff',
    'systemctl poweroff',
    'init 0',
    'chmod -R 777 /',
    'kill -9 -1',
  ];

  it.each(blocked)('refuses catastrophic command: %s', (cmd) => {
    const match = checkHardline(cmd);
    expect(match, `expected "${cmd}" to be blocked`).not.toBeNull();
    expect(match!.description).toBeTruthy();
  });

  it('catches obfuscated rm -rf / (backslash split)', () => {
    expect(checkHardline('r\\m -rf /')).not.toBeNull();
  });

  it('catches obfuscated rm -rf / (fullwidth)', () => {
    expect(checkHardline('ｒｍ -rf /')).not.toBeNull();
  });

  it('catches obfuscated rm -rf / (whitespace padding + ANSI)', () => {
    expect(checkHardline('\x1b[1mrm\x1b[0m   -rf    /')).not.toBeNull();
  });

  const allowed = [
    'git status',
    'rm -rf ./build',
    'rm -rf node_modules',
    'rm -rf /tmp/my-scratch',
    'echo reboot',
    "grep 'shutdown' /var/log/syslog",
    'chmod -R 777 ./dist',
    'npm test',
    'mkfsomething --help',
    'dd if=in.txt of=out.txt',
  ];

  it.each(allowed)('allows recoverable / benign command: %s', (cmd) => {
    expect(checkHardline(cmd), `expected "${cmd}" to be allowed`).toBeNull();
  });
});

/**
 * EXT-55 — the hardline floor is the last line of defence and does not trust the layers above
 * it, so it is audited independently. `CMD_POS` already listed `\n` as a command position, but
 * the individual patterns terminated on `(?:$|[;&|])`, which omitted it — so a catastrophic
 * command with ANYTHING after it on the next line was not matched:
 * `checkHardline('ls\nrm -rf /\nls -la')` returned null while `checkHardline('rm -rf /')` blocked.
 */
describe('checkHardline — line breaks terminate a command (EXT-55)', () => {
  // Every separator must behave the same; `;` is the reference behaviour.
  const separators: ReadonlyArray<readonly [string, string]> = [
    ['; (reference)', ';'],
    ['\\n', '\n'],
    ['\\r', '\r'],
    ['\\r\\n', '\r\n'],
  ];

  it.each(separators)('blocks a catastrophic command followed by more input (%s)', (_l, sep) => {
    expect(checkHardline(`ls${sep}rm -rf /${sep}ls -la`)).not.toBeNull();
    expect(checkHardline(`ls${sep}rm -rf /*${sep}ls`)).not.toBeNull();
    expect(checkHardline(`ls${sep}rm -rf /etc${sep}ls`)).not.toBeNull();
    expect(checkHardline(`ls${sep}rm -rf /usr/*${sep}ls`)).not.toBeNull();
    expect(checkHardline(`ls${sep}rm -rf ~${sep}ls`)).not.toBeNull();
    expect(checkHardline(`ls${sep}rm -rf $HOME${sep}ls`)).not.toBeNull();
    expect(checkHardline(`ls${sep}sudo rm -rf /${sep}ls`)).not.toBeNull();
  });

  it.each(separators)('blocks a catastrophic command as the LAST line (%s)', (_l, sep) => {
    expect(checkHardline(`ls -la${sep}rm -rf /`)).not.toBeNull();
    expect(checkHardline(`echo hi${sep}rm -rf /etc`)).not.toBeNull();
  });

  it.each(separators)('anchors the shutdown family to a command position after a %s', (_l, sep) => {
    expect(checkHardline(`ls${sep}reboot`)).not.toBeNull();
    expect(checkHardline(`ls${sep}sudo poweroff${sep}ls`)).not.toBeNull();
  });

  it.each(separators)('still allows a benign multi-command string (%s)', (_l, sep) => {
    expect(checkHardline(`ls${sep}rm -rf ./build${sep}ls`)).toBeNull();
    expect(checkHardline(`npm test${sep}echo reboot`)).toBeNull();
  });
});
