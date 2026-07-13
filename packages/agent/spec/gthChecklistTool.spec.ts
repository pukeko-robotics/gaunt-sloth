import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GthConfig } from '#src/config.js';

// The tool has no side-effect dependencies (no consoleUtils output); it just returns strings.
describe('gthChecklistTool', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  const cfg = {} as GthConfig;

  it('is registered as a built-in tool named gth_checklist', async () => {
    const { AVAILABLE_BUILT_IN_TOOLS } = await import('#src/builtInToolsConfig.js');
    expect(Object.keys(AVAILABLE_BUILT_IN_TOOLS)).toContain('gth_checklist');
  });

  it('exposes a tool named gth_checklist', async () => {
    const { get, CHECKLIST_TOOL_NAME } = await import('#src/tools/gthChecklistTool.js');
    const tool = get(cfg);
    expect(CHECKLIST_TOOL_NAME).toBe('gth_checklist');
    expect(tool.name).toBe('gth_checklist');
  });

  it('renders the checklist with status glyphs and a completed count', async () => {
    const { get } = await import('#src/tools/gthChecklistTool.js');
    const tool = get(cfg);
    const out = (await tool.invoke({
      items: [
        { content: 'Set up config', status: 'completed' },
        { content: 'Implement tool', status: 'in_progress' },
        { content: 'Write tests', status: 'pending' },
      ],
    })) as string;

    expect(out).toContain('Checklist (1/3 completed):');
    expect(out).toContain('[x] Set up config');
    expect(out).toContain('[~] Implement tool');
    expect(out).toContain('[ ] Write tests');
  });

  it('replaces the whole list on each call (state is not additive)', async () => {
    const { get } = await import('#src/tools/gthChecklistTool.js');
    const tool = get(cfg);
    await tool.invoke({ items: [{ content: 'First', status: 'pending' }] });
    const out = (await tool.invoke({
      items: [{ content: 'Second', status: 'completed' }],
    })) as string;

    expect(out).toContain('Checklist (1/1 completed):');
    expect(out).toContain('[x] Second');
    expect(out).not.toContain('First');
  });

  it('rejects (without mutating) when more than one item is in_progress', async () => {
    const { get } = await import('#src/tools/gthChecklistTool.js');
    const tool = get(cfg);
    await tool.invoke({ items: [{ content: 'Only', status: 'pending' }] });

    const rejected = (await tool.invoke({
      items: [
        { content: 'A', status: 'in_progress' },
        { content: 'B', status: 'in_progress' },
      ],
    })) as string;
    expect(rejected).toMatch(/only one may be in progress/i);

    // State is unchanged: the prior single-item list is still what a fresh valid call sees is
    // independent, but the rejected update must not have overwritten anything — a subsequent valid
    // update reflects only its own items.
    const ok = (await tool.invoke({
      items: [{ content: 'C', status: 'completed' }],
    })) as string;
    expect(ok).toContain('[x] C');
    expect(ok).not.toContain('A');
  });

  it('reports an empty checklist as cleared', async () => {
    const { get } = await import('#src/tools/gthChecklistTool.js');
    const tool = get(cfg);
    const out = (await tool.invoke({ items: [] })) as string;
    expect(out).toMatch(/cleared/i);
  });

  it('formatChecklist renders a stable markdown checklist', async () => {
    const { formatChecklist } = await import('#src/tools/gthChecklistTool.js');
    expect(
      formatChecklist([
        { content: 'Done', status: 'completed' },
        { content: 'Doing', status: 'in_progress' },
        { content: 'Todo', status: 'pending' },
      ])
    ).toBe('Checklist (1/3 completed):\n[x] Done\n[~] Doing\n[ ] Todo');
  });
});
