import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { OutputBuffer } from '#src/tools/shell/outputBuffer.js';

describe('OutputBuffer', () => {
  it('returns output verbatim when under the budget', () => {
    const buf = new OutputBuffer(1000);
    buf.append('hello ');
    buf.append('world');
    const out = buf.finalize();
    expect(out.truncated).toBe(false);
    expect(out.text).toBe('hello world');
    expect(out.spillPath).toBeUndefined();
    expect(out.totalBytes).toBe(11);
  });

  it('keeps head + tail and drops the middle when over budget', () => {
    const buf = new OutputBuffer(20); // 10 head / 10 tail
    const head = 'AAAAAAAAAA'; // 10
    const middle = 'M'.repeat(500);
    const tail = 'ZZZZZZZZZZ'; // 10
    buf.append(head + middle + tail);

    let spilled = '';
    const out = buf.finalize((content) => {
      spilled = content;
      return '/tmp/fake-spill.log';
    });

    expect(out.truncated).toBe(true);
    expect(out.text.startsWith('AAAAAAAAAA')).toBe(true);
    expect(out.text.endsWith('ZZZZZZZZZZ')).toBe(true);
    expect(out.text).toContain('output truncated');
    expect(out.text).toContain('/tmp/fake-spill.log');
    expect(out.text).toContain('read_file');
    // The full output is spilled, not the truncated preview.
    expect(spilled).toBe(head + middle + tail);
    expect(out.spillPath).toBe('/tmp/fake-spill.log');
  });

  it('spills to a real temp file by default and the file holds the full output', () => {
    const buf = new OutputBuffer(20);
    const full = 'X'.repeat(2000);
    buf.append(full);
    const out = buf.finalize();
    expect(out.truncated).toBe(true);
    expect(out.spillPath).toBeTruthy();
    const onDisk = readFileSync(out.spillPath!, 'utf8');
    expect(onDisk).toBe(full);
  });
});
