/**
 * EXT-58 acceptance for spec §7 — what the model is told when a gated call is refused.
 *
 * The bar the spec sets: a rejection MUST name the moves available to the model, not merely the
 * refusal, and when the rater named an already-granted alternative (§4.4) the message MUST carry it
 * AND say the alternative needs no approval. That last clause is the sentence that actually
 * redirects behaviour — a tool name alone gives the model no reason to believe calling it is
 * cheaper than re-arguing the command it already chose.
 */
import { describe, expect, it } from 'vitest';
import {
  buildGrantedAlternativeClause,
  buildRejectionMessage,
  REJECTION_MOVES,
} from '#src/core/shell/rejection.js';

describe('§7 rejection message', () => {
  it('names all three moves, always', () => {
    const message = buildRejectionMessage({ source: 'user', toolName: 'run_shell_command' });
    expect(message).toContain('call the same command with a justification');
    expect(message).toContain('call a different command');
    expect(message).toContain('ask the user if there is no way around it');
    expect(message).toContain(REJECTION_MOVES);
  });

  it('says who refused and what', () => {
    expect(buildRejectionMessage({ source: 'user', toolName: 'run_shell_command' })).toContain(
      'The user rejected your call to run_shell_command.'
    );
    expect(buildRejectionMessage({ source: 'rater', toolName: 'run_shell_command' })).toContain(
      'The auto-rater rejected your call to run_shell_command.'
    );
  });

  it('carries the rating explanation when one exists', () => {
    const message = buildRejectionMessage({
      source: 'user',
      toolName: 'run_shell_command',
      verdict: { outcome: 'destructive', reason: 'deletes a directory tree irreversibly' },
    });
    expect(message).toContain('Explanation: deletes a directory tree irreversibly');
  });

  it('omits the explanation at the unrated rungs, where there is no rating at all', () => {
    // read-only / write consult no model, so there is nothing to quote — but the moves still apply.
    const message = buildRejectionMessage({ source: 'user', toolName: 'run_shell_command' });
    expect(message).not.toContain('Explanation:');
    expect(message).toContain(REJECTION_MOVES);
  });

  it('carries the granted alternative PLUS the no-approval-needed clause (§4.4 → §7)', () => {
    const message = buildRejectionMessage({
      source: 'user',
      toolName: 'run_shell_command',
      verdict: {
        outcome: 'destructive',
        reason: 'rewrites a file in place; edit_file does this without a shell',
        suggestedTool: 'edit_file',
      },
    });
    expect(message).toContain(
      '`edit_file` does this and is already approved at this level, so it will not interrupt the user.'
    );
    // The clause is what makes the name actionable; a bare name is not enough.
    expect(message).toContain('is already approved at this level');
    expect(message).toContain('will not interrupt the user');
    // The moves survive alongside it — a suggestion narrows the options, it does not replace them.
    expect(message).toContain(REJECTION_MOVES);
  });

  it('adds no alternative clause when the rater named none', () => {
    const message = buildRejectionMessage({
      source: 'user',
      toolName: 'run_shell_command',
      verdict: { outcome: 'destructive', reason: 'reads a path outside the working folder' },
    });
    expect(message).not.toContain('already approved at this level');
  });

  it('falls back to a generic target when no tool name is supplied', () => {
    expect(buildRejectionMessage({ source: 'rater' })).toContain(
      'The auto-rater rejected your command.'
    );
  });

  it('renders the alternative clause exactly as §7 words it', () => {
    expect(buildGrantedAlternativeClause('gth_grep')).toBe(
      '`gth_grep` does this and is already approved at this level, so it will not interrupt the user.'
    );
  });
});
