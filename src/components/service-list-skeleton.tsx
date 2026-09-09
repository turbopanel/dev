import React from "react";
import { Box, Text } from "ink";
import type { DevService } from "../dev-services.ts";
import { SERVICE_LIST_ORDER } from "../lib/service-list-visibility.ts";
import { INSTALL_SPINNER_FRAMES } from "../lib/spinners.ts";
import { useSpinnerFrame } from "../hooks/use-spinner-frame.ts";
import { BORDER_COLOR, MENU_BLUE } from "../theme.ts";

/**
 * Stand-in rows used to size the list pane while the first scan is in flight,
 * so the layout does not jump sideways once real service names arrive.
 */
export const SKELETON_SERVICES: DevService[] = SERVICE_LIST_ORDER.map((id) => ({
  id,
  label: id,
  status: "uninstalled",
}));

/**
 * Scaffold shown while the first systemd/Docker status scan is in flight.
 *
 * The scan is async now, so the console paints immediately and fills this in
 * rather than freezing on a blank frame until every probe has returned.
 */
export function ServiceListSkeleton({
  width,
  height,
}: Readonly<{
  width: number;
  height: number;
}>) {
  const frame = useSpinnerFrame(120);
  const glyph = INSTALL_SPINNER_FRAMES[frame % INSTALL_SPINNER_FRAMES.length];
  const innerWidth = Math.max(1, width - 1);
  const rows = SKELETON_SERVICES.slice(0, Math.max(0, height - 2));

  return (
    <Box flexDirection="column" width={width} height={height}>
      <Text color={MENU_BLUE} wrap="truncate">
        {glyph} Scanning…
      </Text>
      <Box height={1} />
      {rows.map((service, index) => {
        // Pulse the bars so the pane reads as busy rather than stalled.
        const lit = (frame + index) % rows.length < 3;
        const barWidth = Math.max(1, Math.min(service.label.length, innerWidth));
        return (
          <Text key={service.id} color={BORDER_COLOR} dimColor={!lit} wrap="truncate">
            {` ${"─".repeat(barWidth)}`}
          </Text>
        );
      })}
    </Box>
  );
}
