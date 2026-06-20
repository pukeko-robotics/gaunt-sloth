import React, { useState } from 'react';
import { Box, Text } from 'ink';
import TextInput from 'ink-text-input';

/**
 * The user prompt line. Mirrors the readline `  > ` prompt. Clears on submit; the parent
 * hides it while a turn is running so Ink owns stdin uncontended during streaming.
 */
export function PromptInput({
  onSubmit,
}: {
  onSubmit: (value: string) => void;
}): React.ReactElement {
  const [value, setValue] = useState('');
  return (
    <Box>
      <Text color="cyan">{'  > '}</Text>
      <TextInput
        value={value}
        onChange={setValue}
        onSubmit={(submitted) => {
          setValue('');
          onSubmit(submitted);
        }}
      />
    </Box>
  );
}
