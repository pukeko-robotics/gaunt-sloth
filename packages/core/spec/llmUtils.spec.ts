import { describe, test, expect, vi } from 'vitest';

// Mock node:crypto randomUUID for deterministic tests
vi.mock('node:crypto', async () => {
  const actual = await vi.importActual<typeof import('node:crypto')>('node:crypto');
  return {
    ...actual,
    randomUUID: () => '12345678-aaaa-bbbb-cccc-1234567890ab',
  };
});

import { wrapContent } from '#src/utils/llmUtils.js';

// [[TUI-C111]] — the `Requested tools:` line. A path is cut from the START so the file name
// survives; every other argument keeps its end cut.
describe('formatToolCallArgs — path arguments keep their end', () => {
  const JAVA_DIR = 'src/main/java/com/example/organisation/project/module/service';
  const SERVICE = `${JAVA_DIR}/UserAccountService.java`;
  const REPOSITORY = `${JAVA_DIR}/UserAccountRepository.java`;

  test('two deep paths differing only in the file name render differently', async () => {
    const { formatToolCallArgs } = await import('#src/utils/llmUtils.js');
    const service = formatToolCallArgs({ path: SERVICE });
    const repository = formatToolCallArgs({ path: REPOSITORY });
    expect(service).not.toBe(repository);
    expect(service).toBe('path: .../project/module/service/UserAccountService.java');
    expect(repository).toBe('path: .../module/service/UserAccountRepository.java');
  });

  test('keeps the cut within the 50-character value cap', async () => {
    const { formatToolCallArgs } = await import('#src/utils/llmUtils.js');
    const value = formatToolCallArgs({ testPath: SERVICE }).slice('testPath: '.length);
    expect(value.startsWith('.../')).toBe(true);
    expect(value.length).toBeLessThanOrEqual(50);
  });

  test('cuts each element of a paths array, and move_file source and destination', async () => {
    const { formatToolCallArgs } = await import('#src/utils/llmUtils.js');
    expect(formatToolCallArgs({ paths: [SERVICE, REPOSITORY] })).toBe(
      'paths: [".../project/module/service/UserAccountService.java",' +
        '".../module/service/UserAccountRepository.java"]'
    );
    const moved = formatToolCallArgs({ source: SERVICE, destination: REPOSITORY });
    expect(moved).toContain('source: .../project/module/service/UserAccountService.java');
    expect(moved).toContain('destination: .../module/service/UserAccountRepository.java');
  });

  test('never splits a surrogate pair at the cut', async () => {
    const { formatToolCallArgs } = await import('#src/utils/llmUtils.js');
    const value = formatToolCallArgs({ path: '😀'.repeat(60) }).slice('path: '.length);
    expect(value).toBe(`...${'😀'.repeat(47)}`);
  });

  test('still cuts a long command from the end', async () => {
    const { formatToolCallArgs } = await import('#src/utils/llmUtils.js');
    const command = `mvn -pl module test -Dtest=UserAccountServiceTest ${'-Dx=1 '.repeat(10)}`;
    expect(formatToolCallArgs({ command })).toBe(`command: ${command.slice(0, 47)}...`);
  });

  test('the Requested tools line names the file', async () => {
    const { formatToolCalls } = await import('#src/utils/llmUtils.js');
    expect(formatToolCalls([{ name: 'gth_gh_read_file', args: { path: SERVICE } }])).toBe(
      'gth_gh_read_file(path: .../project/module/service/UserAccountService.java)'
    );
  });
});

describe('wrapContent', () => {
  test('returns original content when empty and alwaysWrap=false', () => {
    const result = wrapContent('', 'block', 'content', false);
    expect(result).toBe('');
  });

  test('wraps content when non-empty using defaults', () => {
    const input = 'Hello world';
    const result = wrapContent(input);

    const expected =
      `\nProvided content follows within block-1234567 block\n` +
      `<block-1234567>\n` +
      `${input}\n` +
      `</block-1234567>\n`;

    expect(result).toBe(expected);
  });

  test('wraps when empty content but alwaysWrap=true', () => {
    const result = wrapContent('', 'block', 'content', true);

    const expected =
      `\nProvided content follows within block-1234567 block\n` +
      `<block-1234567>\n` +
      `\n` +
      `</block-1234567>\n`;

    expect(result).toBe(expected);
  });

  test('respects custom wrapBlockPrefix and prefix', () => {
    const input = 'Custom content';
    const result = wrapContent(input, 'myblock', 'myPrefix');

    const expected =
      `\nProvided myPrefix follows within myblock-1234567 block\n` +
      `<myblock-1234567>\n` +
      `${input}\n` +
      `</myblock-1234567>\n`;

    expect(result).toBe(expected);
  });
});
