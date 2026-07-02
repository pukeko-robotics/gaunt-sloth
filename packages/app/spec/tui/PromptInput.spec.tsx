import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { PromptInput } from '#src/tui/components/PromptInput.js';
import { SlashCommandMenu } from '#src/tui/components/SlashCommandMenu.js';
import { createCommandRegistry, type SlashCommand } from '#src/tui/slashCommands.js';

const DOWN = '\x1b[B'; // Down arrow CSI sequence
const UP = '\x1b[A'; // Up arrow CSI sequence
const ENTER = '\r';
const TAB = '\t';
const ESC = '\x1b';

const tick = () => new Promise((r) => setTimeout(r, 20));

describe('tui <SlashCommandMenu> (TUI-C10 render)', () => {
  const commands: SlashCommand[] = [
    { name: 'help', description: 'List available slash commands', run: () => ({}) },
    { name: 'mode', description: 'Show the current session mode', run: () => ({}) },
  ];

  it('renders each command name with its description and marks the selected row', () => {
    const { lastFrame } = render(<SlashCommandMenu commands={commands} selectedIndex={1} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('/help');
    expect(frame).toContain('List available slash commands');
    expect(frame).toContain('/mode');
    expect(frame).toContain('Show the current session mode');
    // The highlighted row carries the ❯ marker (mode is index 1).
    expect(frame).toMatch(/❯ \/mode/);
  });

  it('renders nothing when there are no matching commands', () => {
    const { lastFrame } = render(<SlashCommandMenu commands={[]} selectedIndex={0} />);
    expect((lastFrame() ?? '').trim()).toBe('');
  });
});

describe('tui <PromptInput> slash-command menu (TUI-C10 interaction)', () => {
  it('opens the menu listing every command when a bare "/" is typed', async () => {
    const { stdin, lastFrame } = render(
      <PromptInput onSubmit={vi.fn()} commands={createCommandRegistry()} />
    );
    stdin.write('/');
    await tick();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('/help');
    expect(frame).toContain('/mode');
    expect(frame).toContain('/model');
    expect(frame).toContain('/exit');
  });

  it('filters to matching commands as more of the name is typed', async () => {
    const { stdin, lastFrame } = render(
      <PromptInput onSubmit={vi.fn()} commands={createCommandRegistry()} />
    );
    stdin.write('/mo');
    await tick();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('/mode');
    expect(frame).toContain('/model');
    expect(frame).not.toContain('/help');
    expect(frame).not.toContain('/clear');
  });

  it('surfaces extension-registered commands automatically (no hardcoded list)', async () => {
    const registry = createCommandRegistry();
    registry.push({ name: 'ping', description: 'extension command', run: () => ({}) });
    const { stdin, lastFrame } = render(<PromptInput onSubmit={vi.fn()} commands={registry} />);
    stdin.write('/pi');
    await tick();
    expect(lastFrame() ?? '').toContain('/ping');
    expect(lastFrame() ?? '').toContain('extension command');
  });

  it('Enter dispatches the highlighted command (arrow-navigated)', async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(
      <PromptInput onSubmit={onSubmit} commands={createCommandRegistry()} />
    );
    stdin.write('/mo'); // matches: mode, model
    await tick();
    stdin.write(DOWN); // highlight -> model
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith('/model');
  });

  it('Enter on the first match dispatches it (partial input resolves to the full command)', async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(
      <PromptInput onSubmit={onSubmit} commands={createCommandRegistry()} />
    );
    stdin.write('/mo');
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(onSubmit).toHaveBeenCalledWith('/mode');
  });

  it('arrow keys wrap around the match list', async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(
      <PromptInput onSubmit={onSubmit} commands={createCommandRegistry()} />
    );
    stdin.write('/mo'); // [mode, model]
    await tick();
    stdin.write(UP); // wrap from 0 -> last (model)
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(onSubmit).toHaveBeenCalledWith('/model');
  });

  it('Tab completes the highlighted command (adds a trailing space) and closes the menu', async () => {
    const onSubmit = vi.fn();
    const { stdin, lastFrame } = render(
      <PromptInput onSubmit={onSubmit} commands={createCommandRegistry()} />
    );
    stdin.write('/mo');
    await tick();
    stdin.write(DOWN); // -> model
    await tick();
    stdin.write(TAB);
    await tick();
    const frame = lastFrame() ?? '';
    // The menu is gone (the completion added a trailing space, which closes it).
    expect(frame).toContain('/model');
    expect(frame).not.toMatch(/❯/);
    expect(onSubmit).not.toHaveBeenCalled(); // Tab completes, it does not dispatch
    // Prove the trailing space really landed: Enter now submits "/model " verbatim (menu closed).
    stdin.write(ENTER);
    await tick();
    expect(onSubmit).toHaveBeenCalledWith('/model ');
  });

  it('Esc dismisses the menu without clearing the input; typing reopens it', async () => {
    const { stdin, lastFrame } = render(
      <PromptInput onSubmit={vi.fn()} commands={createCommandRegistry()} />
    );
    stdin.write('/mo');
    await tick();
    expect(lastFrame() ?? '').toMatch(/❯/);
    stdin.write(ESC);
    await tick();
    expect(lastFrame() ?? '').not.toMatch(/❯/);
    // Input preserved, and typing more reopens the menu.
    stdin.write('d');
    await tick();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('/mode');
    expect(frame).toContain('/model');
  });

  it('a fully-typed command with no menu (space in it) submits verbatim', async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(
      <PromptInput onSubmit={onSubmit} commands={createCommandRegistry()} />
    );
    stdin.write('/mode now'); // has a space -> menu closed
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(onSubmit).toHaveBeenCalledWith('/mode now');
  });

  it('plain (non-slash) input never shows the menu and submits as typed', async () => {
    const onSubmit = vi.fn();
    const { stdin, lastFrame } = render(
      <PromptInput onSubmit={onSubmit} commands={createCommandRegistry()} />
    );
    stdin.write('hello');
    await tick();
    expect(lastFrame() ?? '').not.toMatch(/❯/);
    stdin.write(ENTER);
    await tick();
    expect(onSubmit).toHaveBeenCalledWith('hello');
  });
});
