import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
// picker.tsx — the BenchAGI agent picker (ink). Renders to stderr so stdout
// stays clean. Returns the chosen agent + connection mode/settings.
import { useState } from "react";
import { Box, Text, render, useApp, useInput } from "ink";
const IR = "#ff2d55";
const DIM = "#7c7c87";
const MODES = [
    { label: "Cloud", value: "tunnel" },
    { label: "Direct", value: "direct" },
    { label: "Claude", value: "local-claude" },
    { label: "Codex", value: "local-codex" },
];
const CLAUDE_MODELS = [
    { label: "Default", value: undefined },
    { label: "Fable 5", value: "claude-fable-5" },
    { label: "Sonnet 4.6", value: "claude-sonnet-4-6" },
    { label: "Opus 4.8", value: "claude-opus-4-8" },
    { label: "Haiku 4.5", value: "claude-haiku-4-5" },
];
const CODEX_MODELS = [
    { label: "Default", value: undefined },
    { label: "GPT-5.5", value: "gpt-5.5" },
    { label: "GPT-5.4", value: "gpt-5.4" },
    { label: "Mini", value: "gpt-5.4-mini" },
    { label: "Spark", value: "gpt-5.3-codex-spark" },
];
const EFFORTS = [
    { label: "Low", value: "low" },
    { label: "Medium", value: "medium" },
    { label: "High", value: "high" },
    { label: "XHigh", value: "xhigh" },
    { label: "Ultra Code", value: "max" },
];
const THINKING = [
    { label: "Show", value: "on" },
    { label: "Compact", value: "collapsed" },
    { label: "Hide", value: "off" },
];
const CONFIG_ROWS = [
    { label: "Environment", value: "environment" },
    { label: "Model", value: "model" },
    { label: "Effort", value: "effort" },
    { label: "Thinking", value: "thinking" },
    { label: "Launch", value: "launch" },
    { label: "Back", value: "back" },
];
function clampIndex(index, length) {
    if (length <= 0)
        return 0;
    return ((index % length) + length) % length;
}
function modelChoices(mode) {
    return mode === "local-codex" ? CODEX_MODELS : CLAUDE_MODELS;
}
function optionRows(label, choices, selected) {
    return choices.map((choice, index) => {
        const active = index === selected;
        return (_jsx(Text, { color: active ? IR : undefined, bold: active, dimColor: !active, children: `${active ? " > " : "   "}${choice.label}` }, `${label}-${index}-${choice.label}`));
    });
}
function summaryRow(label, value, active) {
    return (_jsx(Text, { color: active ? IR : DIM, bold: active, children: `${active ? " > " : "   "}${label.padEnd(9)} ${value}` }));
}
function configValue(row, args) {
    if (row === "environment")
        return args.modeLabel;
    if (row === "model")
        return args.modelLabel;
    if (row === "effort")
        return args.effortLabel;
    if (row === "thinking")
        return args.thinkingLabel;
    if (row === "launch")
        return "Start session";
    return "Choose another agent";
}
function Picker({ agents, opts, onSelect, }) {
    const { exit } = useApp();
    const [stage, setStage] = useState("agent");
    const [agentIndex, setAgentIndex] = useState(0);
    const [configRowIndex, setConfigRowIndex] = useState(0);
    const [modeIndex, setModeIndex] = useState(0);
    const [modelIndex, setModelIndex] = useState(0);
    const [effortIndex, setEffortIndex] = useState(Math.max(0, EFFORTS.findIndex((choice) => choice.value === (opts.initialEffort ?? "high"))));
    const [thinkingIndex, setThinkingIndex] = useState(Math.max(0, THINKING.findIndex((choice) => choice.value === (opts.initialThinking ?? "on"))));
    const selectedAgentIndex = agentIndex >= agents.length ? 0 : clampIndex(agentIndex, agents.length);
    const agent = agents[selectedAgentIndex];
    const mode = MODES[clampIndex(modeIndex, MODES.length)].value;
    const models = modelChoices(mode);
    const modelChoice = models[clampIndex(modelIndex, models.length)];
    const effort = EFFORTS[clampIndex(effortIndex, EFFORTS.length)];
    const thinking = THINKING[clampIndex(thinkingIndex, THINKING.length)];
    const configRow = CONFIG_ROWS[clampIndex(configRowIndex, CONFIG_ROWS.length)].value;
    const agentChoices = [
        ...agents.map((a, index) => ({
            value: index,
            label: `${a.emoji} ${a.name.padEnd(10)} ${a.role.padEnd(14)} ${a.modelShort}`,
        })),
        { value: "exit", label: "Exit Launcher" },
    ];
    const launch = () => {
        onSelect({ mode, agent, model: modelChoice.value, effort: effort.value, thinking: thinking.value });
        exit();
    };
    const moveSelection = (delta) => {
        if (stage === "agent")
            setAgentIndex((i) => clampIndex(i + delta, agentChoices.length));
        else
            setConfigRowIndex((i) => clampIndex(i + delta, CONFIG_ROWS.length));
    };
    const changeConfigValue = (delta) => {
        if (configRow === "environment") {
            setModeIndex((i) => clampIndex(i + delta, MODES.length));
            setModelIndex(0);
        }
        else if (configRow === "model") {
            setModelIndex((i) => clampIndex(i + delta, models.length));
        }
        else if (configRow === "effort") {
            setEffortIndex((i) => clampIndex(i + delta, EFFORTS.length));
        }
        else if (configRow === "thinking") {
            setThinkingIndex((i) => clampIndex(i + delta, THINKING.length));
        }
    };
    const advance = () => {
        if (stage === "agent") {
            if (agentChoices[clampIndex(agentIndex, agentChoices.length)].value === "exit") {
                onSelect({ mode: "quit" });
                exit();
                return;
            }
            setStage("config");
            setConfigRowIndex(0);
            return;
        }
        if (configRow === "launch")
            launch();
        else if (configRow === "back")
            setStage("agent");
        else
            setConfigRowIndex((i) => clampIndex(i + 1, CONFIG_ROWS.length));
    };
    const back = () => {
        if (stage === "config")
            setStage("agent");
    };
    useInput((input, key) => {
        if (key.upArrow)
            moveSelection(-1);
        else if (key.downArrow)
            moveSelection(1);
        else if (key.leftArrow) {
            if (stage === "config" && (configRow === "environment" || configRow === "model" || configRow === "effort" || configRow === "thinking")) {
                changeConfigValue(-1);
            }
            else {
                back();
            }
        }
        else if (key.rightArrow && stage === "config") {
            changeConfigValue(1);
        }
        else if (key.return)
            advance();
        void input;
    });
    const configChoices = CONFIG_ROWS.map((row) => ({
        ...row,
        label: `${row.label.padEnd(12)} ${configValue(row.value, {
            modeLabel: MODES[clampIndex(modeIndex, MODES.length)].label,
            modelLabel: modelChoice.label,
            effortLabel: effort.label,
            thinkingLabel: thinking.label,
        })}`,
    }));
    const currentOptions = stage === "agent"
        ? optionRows("agent", agentChoices, clampIndex(agentIndex, agentChoices.length))
        : optionRows("config", configChoices, clampIndex(configRowIndex, configChoices.length));
    return (_jsxs(Box, { flexDirection: "column", paddingX: 1, children: [_jsx(Text, { color: IR, bold: true, children: "BENCH\u00B7AGI - launch setup" }), _jsx(Box, { marginBottom: 1, children: _jsx(Text, { color: DIM, children: "Use only arrow keys and Enter. Choose an agent, then configure the environment and settings." }) }), _jsxs(Box, { flexDirection: "column", marginTop: 1, children: [summaryRow("Agent", agentChoices[clampIndex(agentIndex, agentChoices.length)].value === "exit" ? "Exit Launcher" : `${agent.emoji} ${agent.name}`, stage === "agent"), summaryRow("Env", MODES[clampIndex(modeIndex, MODES.length)].label, stage === "config" && configRow === "environment"), summaryRow("Model", modelChoice.label, stage === "config" && configRow === "model"), summaryRow("Effort", effort.label, stage === "config" && configRow === "effort"), summaryRow("Thinking", thinking.label, stage === "config" && configRow === "thinking")] }), _jsxs(Box, { flexDirection: "column", marginTop: 1, children: [_jsx(Text, { color: IR, bold: true, children: stage === "agent" ? "Step 1/2: Agent" : "Step 2/2: Environment & Settings" }), currentOptions] }), _jsx(Box, { marginTop: 1, children: _jsx(Text, { color: DIM, children: stage === "agent"
                        ? "Up/Down select agent · Enter continue"
                        : "Up/Down select row · Left/Right change value · Enter continue/launch" }) })] }));
}
export function runPicker(agents, opts = {}) {
    return new Promise((resolve) => {
        let choice = { mode: "quit" };
        const app = render(_jsx(Picker, { agents: agents, opts: opts, onSelect: (c) => (choice = c) }), { stdout: process.stderr });
        void app.waitUntilExit().then(() => resolve(choice));
    });
}
