import { describe, expect, it } from 'vitest';

describe('buildMatrix', () => {
  it('produces a single cell when neither models nor rows are supplied', async () => {
    const { buildMatrix } = await import('#src/matrix.js');
    const cells = buildMatrix('Do the thing.', undefined, undefined);

    expect(cells).toHaveLength(1);
    expect(cells[0]).toMatchObject({
      id: 'cell-0-0',
      modelIndex: 0,
      model: undefined,
      inputIndex: 0,
      inputRow: undefined,
      content: 'Do the thing.',
    });
  });

  it('fans out over models only (no --over)', async () => {
    const { buildMatrix } = await import('#src/matrix.js');
    const cells = buildMatrix('Do the thing.', ['a', 'b', 'c'], undefined);

    expect(cells).toHaveLength(3);
    expect(cells.map((c) => c.model)).toEqual(['a', 'b', 'c']);
    expect(cells.map((c) => c.id)).toEqual(['cell-0-0', 'cell-1-0', 'cell-2-0']);
    // Every cell gets the same content since there's no input axis to interpolate.
    expect(cells.every((c) => c.content === 'Do the thing.')).toBe(true);
  });

  it('fans out over rows only (no --models)', async () => {
    const { buildMatrix } = await import('#src/matrix.js');
    const rows = [{ name: 'alice' }, { name: 'bob' }];
    const cells = buildMatrix('Greet {{name}}.', undefined, rows);

    expect(cells).toHaveLength(2);
    expect(cells.map((c) => c.model)).toEqual([undefined, undefined]);
    expect(cells.map((c) => c.id)).toEqual(['cell-0-0', 'cell-0-1']);
    expect(cells.map((c) => c.content)).toEqual(['Greet alice.', 'Greet bob.']);
    expect(cells.map((c) => c.inputRow)).toEqual(rows);
  });

  it('builds the full cross product when both axes are present', async () => {
    const { buildMatrix } = await import('#src/matrix.js');
    const rows = [{ name: 'alice' }, { name: 'bob' }];
    const cells = buildMatrix('Greet {{name}}.', ['m1', 'm2'], rows);

    expect(cells).toHaveLength(4);
    expect(cells.map((c) => c.id)).toEqual(['cell-0-0', 'cell-0-1', 'cell-1-0', 'cell-1-1']);
    expect(cells.map((c) => `${c.model}:${c.content}`)).toEqual([
      'm1:Greet alice.',
      'm1:Greet bob.',
      'm2:Greet alice.',
      'm2:Greet bob.',
    ]);
  });

  it('treats an empty models/rows array the same as absent (no silent 0-cell matrix)', async () => {
    const { buildMatrix } = await import('#src/matrix.js');
    const cells = buildMatrix('Do the thing.', [], []);

    expect(cells).toHaveLength(1);
  });
});
