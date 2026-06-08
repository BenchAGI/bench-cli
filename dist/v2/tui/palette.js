import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
// palette.tsx — Ctrl+K command palette: a searchable, navigable modal of every command. Type to
// filter, ↑/↓ to select, Enter to run, Esc to close. Rendered in place of the input row while open
// (the App owns the open/close toggle on Ctrl+K).
import { useState } from "react";
import { Box, Text, useInput } from "ink";
import { BRAND_HEX } from "../render/ansi.js";
const SHOWN = 8;
export const PALETTE_ROWS = SHOWN + 5; // border(2) + title(1) + search(1) + items + footer(1)
export function Palette({ commands, width, onRun, onClose, }) {
    const [query, setQuery] = useState("");
    const [sel, setSel] = useState(0);
    const q = query.toLowerCase();
    const filtered = commands.filter((c) => !c.hidden && `/${c.name} ${c.summary}`.toLowerCase().includes(q));
    const clamped = Math.min(sel, Math.max(0, filtered.length - 1));
    useInput((input, key) => {
        if (key.escape)
            return void onClose();
        if (key.ctrl || key.meta)
            return; // Ctrl+K toggle is owned by the App
        if (key.upArrow)
            return void setSel((s) => (filtered.length ? (s - 1 + filtered.length) % filtered.length : 0));
        if (key.downArrow)
            return void setSel((s) => (filtered.length ? (s + 1) % filtered.length : 0));
        if (key.return) {
            if (filtered[clamped])
                onRun(filtered[clamped].name);
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
    return (_jsxs(Box, { flexDirection: "column", borderStyle: "round", borderColor: BRAND_HEX.infrared, paddingX: 1, width: Math.min(width, 64), children: [_jsx(Text, { color: BRAND_HEX.infrared, bold: true, children: "commands" }), _jsxs(Box, { children: [_jsx(Text, { color: BRAND_HEX.dim, children: "> " }), _jsxs(Text, { children: [query, _jsx(Text, { inverse: true, children: " " })] })] }), filtered.slice(0, SHOWN).map((c, i) => {
                const s = i === clamped;
                return (_jsx(Text, { color: s ? BRAND_HEX.infrared : BRAND_HEX.dim, bold: s, children: `${s ? " ▸ " : "   "}/${c.name.padEnd(10)} ${c.summary}` }, c.name));
            }), filtered.length === 0 ? _jsx(Text, { color: BRAND_HEX.dim, children: "   no match" }) : null, _jsx(Text, { color: BRAND_HEX.dim, children: "   ↑/↓ · enter run · esc close" })] }));
}
