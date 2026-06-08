// working.tsx — the in-flight working indicator. Our 🦅 answer to Claude Code's "wrangling…":
// a braille spinner + a rotating eagle word (Soaring/Stooping/Hunting…), deterministic per run so
// it doesn't flicker, rotating every WORD_ROTATE_MS. Shown only while a run is in flight.

import { useEffect, useState } from "react";
import { Box, Text } from "ink";
import { BRAND_HEX } from "../render/ansi.js";
import { wordForElapsed, WORD_ROTATE_MS } from "../render/working-words.js";

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const FRAME_MS = 120;

export function Working({
  active,
  runId,
  note,
}: {
  active: boolean;
  runId: string;
  note?: string;
}): JSX.Element | null {
  const [frame, setFrame] = useState(0);

  // Reset the animation clock whenever a fresh run starts.
  useEffect(() => {
    setFrame(0);
  }, [runId]);

  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setFrame((f) => f + 1), FRAME_MS);
    return () => clearInterval(t);
  }, [active]);

  if (!active) return null;

  const spin = SPINNER[frame % SPINNER.length];
  const word = wordForElapsed(runId, frame * FRAME_MS, WORD_ROTATE_MS);

  return (
    <Box>
      <Text color={BRAND_HEX.infrared}>{`🦅 ${spin} `}</Text>
      <Text color={BRAND_HEX.copper} italic>
        {`${word}…`}
      </Text>
      {note ? <Text color={BRAND_HEX.dim}>{`  ${note}`}</Text> : null}
    </Box>
  );
}
