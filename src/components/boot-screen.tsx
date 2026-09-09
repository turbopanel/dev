import React from "react";
import { Box, Text, useWindowSize } from "ink";
import { INSTALL_SPINNER_FRAMES } from "../lib/spinners.ts";
import { useSpinnerFrame } from "../hooks/use-spinner-frame.ts";
import { MENU_BLUE } from "../theme.ts";

export function BootScreen({ message }: Readonly<{ message: string }>) {
  const { columns, rows } = useWindowSize();
  const frame = useSpinnerFrame(120);
  const glyph = INSTALL_SPINNER_FRAMES[frame % INSTALL_SPINNER_FRAMES.length];

  return (
    <Box flexDirection="column" width={columns} height={rows} paddingX={1}>
      <Text bold color="cyan">TurboPanel Dev Console</Text>
      <Text color={MENU_BLUE}>
        {glyph} <Text dimColor>{message}</Text>
      </Text>
    </Box>
  );
}
