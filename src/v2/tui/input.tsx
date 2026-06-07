// input.tsx — the pinned input row. Controlled line editor (history, multiline, cursor edits) with
// live inline /command hints and the approval-key gate. All editing logic lives in the pure
// input-model reducer; this component only binds ink's useInput and paints.

import { useState } from "react";
import { Box, Text, useInput } from "ink";
import { BRAND_HEX } from "../render/ansi.js";
import { matchHint, type SlashCommand, SLASH_COMMANDS } from "../repl/slash.js";
import { initInput, reduceInput, type InputState } from "./input-model.js";

export function Input({
  busy,
  approvalActive,
  registry = SLASH_COMMANDS,
  initialHistory = [],
  onSubmit,
  onApproval,
  onInterrupt,
  onExit,
}: {
  busy: boolean;
  approvalActive: boolean;
  registry?: readonly SlashCommand[];
  initialHistory?: string[];
  onSubmit: (line: string) => void;
  onApproval: (key: string) => void;
  onInterrupt: () => void;
  onExit: () => void;
}): JSX.Element {
  const [state, setState] = useState<InputState>(() => initInput(initialHistory));

  useInput((input, key) => {
    // App-level chords first (not part of the editor model).
    if (key.ctrl && input === "c") {
      if (busy) onInterrupt();
      else onExit();
      return;
    }
    const { state: next, action } = reduceInput(state, input, key, { approvalActive, registry });
    if (action.type === "submit") onSubmit(action.line);
    else if (action.type === "approval") onApproval(action.key);
    setState(next);
  });

  const hints = matchHint(state.buffer, registry);
  const showHints = state.buffer.startsWith("/") && hints.length > 0;

  // Render the buffer with an inverse-video caret at the cursor.
  const before = state.buffer.slice(0, state.cursor);
  const at = state.buffer.slice(state.cursor, state.cursor + 1) || " ";
  const after = state.buffer.slice(state.cursor + 1);

  const promptColor = approvalActive ? BRAND_HEX.amber : BRAND_HEX.infrared;
  const promptGlyph = approvalActive ? "🔔" : "❯";

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={promptColor} bold>
          {`${promptGlyph} `}
        </Text>
        <Text>
          {before}
          <Text inverse>{at}</Text>
          {after}
        </Text>
      </Box>
      {showHints ? (
        <Box>
          <Text color={BRAND_HEX.dim}>{"  "}</Text>
          {hints.slice(0, 6).map((h: SlashCommand, i) => (
            <Text key={h.name}>
              {i > 0 ? <Text color={BRAND_HEX.dim}>{"  "}</Text> : null}
              <Text color={BRAND_HEX.copper}>{`/${h.name}`}</Text>
              <Text color={BRAND_HEX.dim}>{` ${h.summary}`.length > 28 ? "" : ` ${h.summary}`}</Text>
            </Text>
          ))}
        </Box>
      ) : null}
    </Box>
  );
}
