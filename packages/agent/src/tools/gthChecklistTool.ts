/**
 * @module gthChecklistTool
 * The `gth_checklist` planning tool — the lean agent's first-party equivalent of the deepagents
 * `write_todos` capability. Gives the model a durable, structured task list for multi-step work so
 * it can plan, track progress, and stay oriented across a long run.
 *
 * Design (mirrors Claude Code's `TodoWrite` / opencode's todo tools): the model sends the WHOLE
 * list every call and it REPLACES the previous one (no incremental add/remove verbs to keep in
 * sync). State is a closure private to each `get()` result, i.e. one list per agent init / session,
 * so concurrent sessions (e.g. the AG-UI server) never share a checklist. The tool returns a
 * rendered markdown checklist as its observation; the TUI additionally folds it into a live
 * checkbox panel (see {@link file://../../../app/src/tui/viewModel.ts} `CHECKLIST_TOOL_NAME`).
 *
 * The name is deliberately NOT `write_todos` (nor `task`/`read_file`/`write_file`/`edit_file`/`ls`):
 * on the experimental deep backend `createDeepAgent` throws on a name collision with its built-ins,
 * and both backends share the same resolved toolset.
 */
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { GthConfig } from '@gaunt-sloth/core/config.js';

export const CHECKLIST_TOOL_NAME = 'gth_checklist';

export type ChecklistStatus = 'pending' | 'in_progress' | 'completed';

export interface ChecklistItem {
  content: string;
  status: ChecklistStatus;
}

const itemSchema = z.object({
  content: z
    .string()
    .min(1)
    .describe('Short, imperative description of the task, e.g. "Add tests"'),
  status: z
    .enum(['pending', 'in_progress', 'completed'])
    .describe('pending = not started, in_progress = being worked on now, completed = finished'),
});

const schema = z.object({
  items: z
    .array(itemSchema)
    .describe('The FULL checklist. This replaces any previous checklist entirely.'),
});

const description = [
  'Record and update a checklist (todo list) for the current task. Use it to plan multi-step',
  'work and to show the user your progress. Send the ENTIRE list every time — it replaces the',
  'previous checklist, so include already-completed items too.',
  '',
  'When to use: any task with 3+ distinct steps, or when the user gives several requirements.',
  'Skip it for a single trivial step.',
  '',
  'Rules:',
  '- Keep at most ONE item "in_progress" at a time.',
  '- Mark an item "completed" as soon as it is done — do not batch completions.',
  '- Keep item text short and outcome-focused.',
].join('\n');

const STATUS_GLYPH: Record<ChecklistStatus, string> = {
  completed: '[x]',
  in_progress: '[~]',
  pending: '[ ]',
};

/** Render a checklist as a markdown observation the model (and a plain terminal) can read back. */
export function formatChecklist(items: ChecklistItem[]): string {
  if (items.length === 0) {
    return 'Checklist cleared (no items).';
  }
  const completed = items.filter((i) => i.status === 'completed').length;
  const header = `Checklist (${completed}/${items.length} completed):`;
  const lines = items.map((i) => `${STATUS_GLYPH[i.status]} ${i.content}`);
  return [header, ...lines].join('\n');
}

export function get(_config: GthConfig) {
  // Session-scoped state: one list per tool instance (== per agent init). Whole-list-replace
  // semantics mean each call overwrites this; it is kept so the tool can render the current
  // state back as its observation.
  let items: ChecklistItem[] = [];

  const impl = async ({ items: next }: z.infer<typeof schema>): Promise<string> => {
    const inProgress = next.filter((i) => i.status === 'in_progress').length;
    if (inProgress > 1) {
      // Do NOT mutate state on a malformed update — return guidance so the model can retry.
      return (
        `Rejected: ${inProgress} items are "in_progress" but only one may be in progress at a ` +
        'time. Set all but the current task to "pending" or "completed" and call gth_checklist ' +
        'again.'
      );
    }
    items = next;
    return formatChecklist(items);
  };

  return tool(impl, { name: CHECKLIST_TOOL_NAME, description, schema });
}
