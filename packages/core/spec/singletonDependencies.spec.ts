import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

describe('Singleton dependency resolution', () => {
  it('proves @langchain/core resolves to the exact same singleton instance across packages', () => {
    const req = createRequire(import.meta.url);
    const coreDirect = req.resolve('@langchain/core');
    const openrouterEntry = req.resolve('@langchain/openrouter');
    const coreViaOpenRouter = req.resolve('@langchain/core', { paths: [openrouterEntry] });

    expect(coreDirect).toBe(coreViaOpenRouter);
  });

  it('proves @langchain/openai resolves to the exact same singleton instance across packages', () => {
    const req = createRequire(import.meta.url);
    const openaiDirect = req.resolve('@langchain/openai');
    const openrouterEntry = req.resolve('@langchain/openrouter');
    const openaiViaOpenRouter = req.resolve('@langchain/openai', { paths: [openrouterEntry] });

    expect(openaiDirect).toBe(openaiViaOpenRouter);
  });
});
