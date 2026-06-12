// input.tsx — the pinned input row. CONTROLLED: the App owns the editor state (so the layout can
// make room for the slash menu). Renders a navigable /command menu above the prompt, with the live
// caret below. All editing logic stays in the pure input-model reducer.

import { useState } from "react";
import { Box, Text, useInput } from "ink";
import { BRAND_HEX } from "../render/ansi.js";
import { matchHint, type SlashCommand, SLASH_COMMANDS } from "../repl/slash.js";
import { reduceInput, type InputState } from "./input-model.js";
import { containsMouseEvent } from "./terminal-events.js";

export const MAX_MENU = 8;

// How many rows the slash menu occupies for a given buffer (commands shown + the hint footer), so
// the App can shrink the scroll viewport to fit it. 0 when the menu is closed.
export function slashMenuRows(buffer: string, registry: readonly SlashCommand[] = SLASH_COMMANDS): number {
  if (!buffer.startsWith("/")) return 0;
  const n = matchHint(buffer, registry).length;
  return n > 0 ? Math.min(n, MAX_MENU) + 1 : 0;
}

export function Input({
  state,
  onChange,
  busy,
  approvalActive,
  canConsumeKey,
  registry = SLASH_COMMANDS,
  onSubmit,
  onApproval,
  onInterrupt,
  onExit,
}: {
  state: InputState;
  onChange: (s: InputState) => void;
  busy: boolean;
  approvalActive: boolean;
  canConsumeKey?: (key: string) => boolean;
  registry?: readonly SlashCommand[];
  onSubmit: (line: string) => void;
  onApproval: (key: string) => void;
  onInterrupt: () => void;
  onExit: () => void;
}): JSX.Element {
  const [sel, setSel] = useState(0);

  const hints = matchHint(state.buffer, registry);
  const menuOpen = state.buffer.startsWith("/") && hints.length > 0;
  const clampedSel = Math.min(sel, Math.max(0, hints.length - 1));

  const edit = (input: string, key: Parameters<Parameters<typeof useInput>[0]>[1]): void => {
    const { state: next, action } = reduceInput(state, input, key, { approvalActive: false, registry });
    if (action.type === "submit") onSubmit(action.line);
    else if (action.type === "approval") onApproval(action.key);
    onChange(next);
  };
  const setBuffer = (buffer: string): void => onChange({ ...state, buffer, cursor: buffer.length, histIndex: null });

  useInput((input, key) => {
    if (containsMouseEvent(input)) return;
    // App-level chords first.
    if (key.ctrl && input === "c") {
      if (busy) onInterrupt();
      else onExit();
      return;
    }
    // Live approval-key gate (a/d/r consumed only with an empty buffer while a run is in flight).
    if (state.buffer.length === 0 && input && !key.ctrl && !key.meta && canConsumeKey?.(input)) {
      onApproval(input);
      return;
    }

    // Slash menu open: ↑/↓ drive the menu (overriding history), Tab completes, Enter runs, Esc cancels.
    if (menuOpen) {
      if (key.upArrow) return void setSel((s) => (s - 1 + hints.length) % hints.length);
      if (key.downArrow) return void setSel((s) => (s + 1) % hints.length);
      if (key.tab) {
        setBuffer(`/${hints[clampedSel]!.name} `);
        setSel(0);
        return;
      }
      if (key.return) {
        onSubmit(`/${hints[clampedSel]!.name}`);
        onChange({ ...state, buffer: "", cursor: 0, histIndex: null });
        setSel(0);
        return;
      }
      if (key.escape) {
        onChange({ ...state, buffer: "", cursor: 0, histIndex: null });
        setSel(0);
        return;
      }
      edit(input, key); // typing filters the menu
      setSel(0);
      return;
    }

    edit(input, key);
  });

  const before = state.buffer.slice(0, state.cursor);
  const at = state.buffer.slice(state.cursor, state.cursor + 1) || " ";
  const after = state.buffer.slice(state.cursor + 1);
  const promptColor = approvalActive ? BRAND_HEX.amber : BRAND_HEX.infrared;
  const promptGlyph = approvalActive ? "🔔" : "❯";

  return (
    <Box flexDirection="column">
      {menuOpen ? (
        <Box flexDirection="column">
          {hints.slice(0, MAX_MENU).map((cmd: SlashCommand, i) => {
            const seld = i === clampedSel;
            return (
              <Text key={cmd.name} color={seld ? BRAND_HEX.infrared : BRAND_HEX.dim} bold={seld}>
                {`${seld ? " ▸ " : "   "}/${cmd.name.padEnd(10)} ${cmd.summary}`}
              </Text>
            );
          })}
          <Text color={BRAND_HEX.dim}>{"   ↑/↓ pick · tab complete · enter run · esc cancel"}</Text>
        </Box>
      ) : null}
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
    </Box>
  );
}
