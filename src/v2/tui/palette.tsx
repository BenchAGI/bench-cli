// palette.tsx — Ctrl+K command palette: a searchable, navigable modal of every command. Type to
// filter, ↑/↓ to select, Enter to run, Esc to close. Rendered in place of the input row while open
// (the App owns the open/close toggle on Ctrl+K).

import { useState } from "react";
import { Box, Text, useInput } from "ink";
import { BRAND_HEX } from "../render/ansi.js";
import type { SlashCommand } from "../repl/slash.js";

const SHOWN = 8;
export const PALETTE_ROWS = SHOWN + 5; // border(2) + title(1) + search(1) + items + footer(1)

export function Palette({
  commands,
  width,
  onRun,
  onClose,
}: {
  commands: readonly SlashCommand[];
  width: number;
  onRun: (name: string) => void;
  onClose: () => void;
}): JSX.Element {
  const [query, setQuery] = useState("");
  const [sel, setSel] = useState(0);

  const q = query.toLowerCase();
  const filtered = commands.filter((c) => !c.hidden && `/${c.name} ${c.summary}`.toLowerCase().includes(q));
  const clamped = Math.min(sel, Math.max(0, filtered.length - 1));

  useInput((input, key) => {
    if (key.escape) return void onClose();
    if (key.ctrl || key.meta) return; // Ctrl+K toggle is owned by the App
    if (key.upArrow) return void setSel((s) => (filtered.length ? (s - 1 + filtered.length) % filtered.length : 0));
    if (key.downArrow) return void setSel((s) => (filtered.length ? (s + 1) % filtered.length : 0));
    if (key.return) {
      if (filtered[clamped]) onRun(filtered[clamped]!.name);
      return;
    }
    if (key.backspace || key.delete) {
      setQuery((x) => x.slice(0, -1));
      setSel(0);
      return;
    }
    if (input) {
      setQuery((x) => x + input);
      setSel(0);
    }
  });

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={BRAND_HEX.infrared}
      paddingX={1}
      width={Math.min(width, 64)}
    >
      <Text color={BRAND_HEX.infrared} bold>
        commands
      </Text>
      <Box>
        <Text color={BRAND_HEX.dim}>{"> "}</Text>
        <Text>
          {query}
          <Text inverse>{" "}</Text>
        </Text>
      </Box>
      {filtered.slice(0, SHOWN).map((c, i) => {
        const s = i === clamped;
        return (
          <Text key={c.name} color={s ? BRAND_HEX.infrared : BRAND_HEX.dim} bold={s}>
            {`${s ? " ▸ " : "   "}/${c.name.padEnd(10)} ${c.summary}`}
          </Text>
        );
      })}
      {filtered.length === 0 ? <Text color={BRAND_HEX.dim}>{"   no match"}</Text> : null}
      <Text color={BRAND_HEX.dim}>{"   ↑/↓ · enter run · esc close"}</Text>
    </Box>
  );
}
