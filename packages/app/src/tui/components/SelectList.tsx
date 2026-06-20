import React, { useState } from 'react';
import { Box, Text, useApp, useInput } from 'ink';

export interface SelectItem {
  /** The text shown for this row. */
  label: string;
}

/**
 * CFG-11 — a minimal arrow-key + Enter selectable list for the first-run dialog. Up/Down
 * (and k/j) move the highlight, Enter confirms. It deliberately has no number-typing path:
 * the readline number menu remains the non-TTY fallback, this is the keyboard-driven TUI one.
 *
 * `onSelect` is called once with the chosen index; the caller is responsible for unmounting
 * (the default `runInkSelect` host calls `useApp().exit()` via `onSelect`).
 */
export function SelectList({
  title,
  items,
  initialIndex = 0,
  onSelect,
}: {
  title: string;
  items: SelectItem[];
  initialIndex?: number;
  onSelect: (index: number) => void;
}): React.ReactElement {
  const [cursor, setCursor] = useState(
    initialIndex >= 0 && initialIndex < items.length ? initialIndex : 0
  );

  useInput((input, key) => {
    if (key.upArrow || input === 'k') {
      setCursor((c) => (c - 1 + items.length) % items.length);
    } else if (key.downArrow || input === 'j') {
      setCursor((c) => (c + 1) % items.length);
    } else if (key.return) {
      onSelect(cursor);
    }
  });

  return (
    <Box flexDirection="column">
      <Text>{title}</Text>
      {items.map((item, index) => {
        const selected = index === cursor;
        return (
          <Text key={index} color={selected ? 'cyan' : undefined}>
            {selected ? '❯ ' : '  '}
            {item.label}
          </Text>
        );
      })}
    </Box>
  );
}

/**
 * Renders {@link SelectList} with Ink and resolves with the chosen index. Imports `ink`
 * dynamically so this module never pulls Ink into a readline-only run. Intended to be used
 * only after the caller has confirmed an interactive TTY + Ink availability.
 */
export async function runInkSelect(
  title: string,
  items: SelectItem[],
  initialIndex = 0
): Promise<number> {
  const { render } = await import('ink');
  return await new Promise<number>((resolve) => {
    let chosen = initialIndex;
    const Host = (): React.ReactElement => {
      const { exit } = useApp();
      return (
        <SelectList
          title={title}
          items={items}
          initialIndex={initialIndex}
          onSelect={(index) => {
            chosen = index;
            exit();
          }}
        />
      );
    };
    const instance = render(<Host />);
    instance.waitUntilExit().then(() => resolve(chosen));
  });
}
