import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
// picker.tsx — the BenchAGI agent picker (ink). Renders to stderr so stdout
// stays clean. Returns the chosen agent + connection mode.
import { useState } from "react";
import { Box, Text, render, useApp, useInput } from "ink";
const IR = "#ff2d55";
const DIM = "#7c7c87";
function Picker({ agents, onSelect }) {
    const { exit } = useApp();
    const [index, setIndex] = useState(0);
    useInput((input, key) => {
        if (key.upArrow || input === "k")
            setIndex((i) => (i - 1 + agents.length) % agents.length);
        else if (key.downArrow || input === "j")
            setIndex((i) => (i + 1) % agents.length);
        else if (key.return) {
            onSelect({ mode: "tunnel", agent: agents[index] });
            exit();
        }
        else if (input === "l") {
            onSelect({ mode: "local-claude", agent: agents[index] });
            exit();
        }
        else if (input === "x") {
            onSelect({ mode: "local-codex", agent: agents[index] });
            exit();
        }
        else if (input === "d") {
            onSelect({ mode: "direct", agent: agents[index] });
            exit();
        }
        else if (input === "q" || key.escape) {
            onSelect({ mode: "quit" });
            exit();
        }
    });
    return (_jsxs(Box, { flexDirection: "column", paddingX: 1, children: [_jsx(Text, { color: IR, bold: true, children: "BENCH\u00B7AGI \u2014 choose an agent" }), _jsx(Box, { marginBottom: 1, children: _jsx(Text, { color: DIM, children: "tunnel = Bench harness \u00B7 direct = gateway URL \u00B7 local = Claude Code or Codex CLI" }) }), agents.map((a, i) => {
                const sel = i === index;
                const label = `${a.emoji} ${a.name.padEnd(10)} ${a.role.padEnd(14)} ${a.modelShort}`;
                return (_jsx(Text, { color: sel ? IR : undefined, bold: sel, dimColor: !sel, children: `${sel ? " ▸ " : "   "}${label}` }, a.agentId));
            }), _jsx(Box, { marginTop: 1, children: _jsx(Text, { color: DIM, children: "\u2191/\u2193 move \u00B7 enter tunnel \u00B7 d direct \u00B7 l Claude Code \u00B7 x Codex CLI \u00B7 q quit" }) })] }));
}
export function runPicker(agents) {
    return new Promise((resolve) => {
        let choice = { mode: "quit" };
        const app = render(_jsx(Picker, { agents: agents, onSelect: (c) => (choice = c) }), { stdout: process.stderr });
        void app.waitUntilExit().then(() => resolve(choice));
    });
}
