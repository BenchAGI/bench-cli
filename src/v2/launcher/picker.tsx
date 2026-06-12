// picker.tsx — the BenchAGI agent picker (ink). Renders to stderr so stdout
// stays clean. Returns the chosen agent + connection mode/settings.

import { useState } from "react";
import { Box, Text, render, useApp, useInput } from "ink";

import type { ThinkingMode } from "../render/stream.js";
import type { LauncherAgent } from "./roster.js";

export type PickerMode = "tunnel" | "direct" | "local-claude" | "local-codex" | "quit";
export type PickerEffort = "low" | "medium" | "high" | "xhigh" | "max";

export interface PickerChoice {
  mode: PickerMode;
  agent?: LauncherAgent;
  model?: string;
  effort?: PickerEffort;
  thinking?: ThinkingMode;
}

export interface PickerOpts {
  initialThinking?: ThinkingMode;
  initialEffort?: PickerEffort;
}

type ButtonChoice<T extends string | number | undefined = string | undefined> = {
  label: string;
  value: T;
};

type PickerStage = "agent" | "config";
type AgentChoice = number | "exit";
type ConfigRow = "environment" | "model" | "effort" | "thinking" | "launch" | "back";

const IR = "#ff2d55";
const DIM = "#7c7c87";

const MODES: ButtonChoice<PickerMode>[] = [
  { label: "Cloud", value: "tunnel" },
  { label: "Direct", value: "direct" },
  { label: "Claude", value: "local-claude" },
  { label: "Codex", value: "local-codex" },
];

const CLAUDE_MODELS: ButtonChoice[] = [
  { label: "Default", value: undefined },
  { label: "Fable 5", value: "claude-fable-5" },
  { label: "Sonnet 4.6", value: "claude-sonnet-4-6" },
  { label: "Opus 4.8", value: "claude-opus-4-8" },
  { label: "Haiku 4.5", value: "claude-haiku-4-5" },
];

const CODEX_MODELS: ButtonChoice[] = [
  { label: "Default", value: undefined },
  { label: "GPT-5.5", value: "gpt-5.5" },
  { label: "GPT-5.4", value: "gpt-5.4" },
  { label: "Mini", value: "gpt-5.4-mini" },
  { label: "Spark", value: "gpt-5.3-codex-spark" },
];

const EFFORTS: ButtonChoice<PickerEffort>[] = [
  { label: "Low", value: "low" },
  { label: "Medium", value: "medium" },
  { label: "High", value: "high" },
  { label: "XHigh", value: "xhigh" },
  { label: "Ultra Code", value: "max" },
];

const THINKING: ButtonChoice<ThinkingMode>[] = [
  { label: "Show", value: "on" },
  { label: "Compact", value: "collapsed" },
  { label: "Hide", value: "off" },
];

const CONFIG_ROWS: ButtonChoice<ConfigRow>[] = [
  { label: "Environment", value: "environment" },
  { label: "Model", value: "model" },
  { label: "Effort", value: "effort" },
  { label: "Thinking", value: "thinking" },
  { label: "Launch", value: "launch" },
  { label: "Back", value: "back" },
];

function clampIndex(index: number, length: number): number {
  if (length <= 0) return 0;
  return ((index % length) + length) % length;
}

function modelChoices(mode: PickerMode): ButtonChoice[] {
  return mode === "local-codex" ? CODEX_MODELS : CLAUDE_MODELS;
}

function optionRows<T extends string | number | undefined>(
  label: string,
  choices: ButtonChoice<T>[],
  selected: number,
): JSX.Element[] {
  return choices.map((choice, index) => {
    const active = index === selected;
    return (
      <Text key={`${label}-${index}-${choice.label}`} color={active ? IR : undefined} bold={active} dimColor={!active}>
        {`${active ? " > " : "   "}${choice.label}`}
      </Text>
    );
  });
}

function summaryRow(label: string, value: string, active: boolean): JSX.Element {
  return (
    <Text color={active ? IR : DIM} bold={active}>
      {`${active ? " > " : "   "}${label.padEnd(9)} ${value}`}
    </Text>
  );
}

function configValue(row: ConfigRow, args: {
  modeLabel: string;
  modelLabel: string;
  effortLabel: string;
  thinkingLabel: string;
}): string {
  if (row === "environment") return args.modeLabel;
  if (row === "model") return args.modelLabel;
  if (row === "effort") return args.effortLabel;
  if (row === "thinking") return args.thinkingLabel;
  if (row === "launch") return "Start session";
  return "Choose another agent";
}

function Picker({
  agents,
  opts,
  onSelect,
}: {
  agents: LauncherAgent[];
  opts: PickerOpts;
  onSelect: (c: PickerChoice) => void;
}): JSX.Element {
  const { exit } = useApp();
  const [stage, setStage] = useState<PickerStage>("agent");
  const [agentIndex, setAgentIndex] = useState(0);
  const [configRowIndex, setConfigRowIndex] = useState(0);
  const [modeIndex, setModeIndex] = useState(0);
  const [modelIndex, setModelIndex] = useState(0);
  const [effortIndex, setEffortIndex] = useState(
    Math.max(0, EFFORTS.findIndex((choice) => choice.value === (opts.initialEffort ?? "high"))),
  );
  const [thinkingIndex, setThinkingIndex] = useState(
    Math.max(0, THINKING.findIndex((choice) => choice.value === (opts.initialThinking ?? "on"))),
  );

  const selectedAgentIndex = agentIndex >= agents.length ? 0 : clampIndex(agentIndex, agents.length);
  const agent = agents[selectedAgentIndex]!;
  const mode = MODES[clampIndex(modeIndex, MODES.length)]!.value;
  const models = modelChoices(mode);
  const modelChoice = models[clampIndex(modelIndex, models.length)]!;
  const effort = EFFORTS[clampIndex(effortIndex, EFFORTS.length)]!;
  const thinking = THINKING[clampIndex(thinkingIndex, THINKING.length)]!;
  const configRow = CONFIG_ROWS[clampIndex(configRowIndex, CONFIG_ROWS.length)]!.value;

  const agentChoices: ButtonChoice<AgentChoice>[] = [
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

  const moveSelection = (delta: number) => {
    if (stage === "agent") setAgentIndex((i) => clampIndex(i + delta, agentChoices.length));
    else setConfigRowIndex((i) => clampIndex(i + delta, CONFIG_ROWS.length));
  };

  const changeConfigValue = (delta: number) => {
    if (configRow === "environment") {
      setModeIndex((i) => clampIndex(i + delta, MODES.length));
      setModelIndex(0);
    } else if (configRow === "model") {
      setModelIndex((i) => clampIndex(i + delta, models.length));
    } else if (configRow === "effort") {
      setEffortIndex((i) => clampIndex(i + delta, EFFORTS.length));
    } else if (configRow === "thinking") {
      setThinkingIndex((i) => clampIndex(i + delta, THINKING.length));
    }
  };

  const advance = () => {
    if (stage === "agent") {
      if (agentChoices[clampIndex(agentIndex, agentChoices.length)]!.value === "exit") {
        onSelect({ mode: "quit" });
        exit();
        return;
      }
      setStage("config");
      setConfigRowIndex(0);
      return;
    }
    if (configRow === "launch") launch();
    else if (configRow === "back") setStage("agent");
    else setConfigRowIndex((i) => clampIndex(i + 1, CONFIG_ROWS.length));
  };

  const back = () => {
    if (stage === "config") setStage("agent");
  };

  useInput((input, key) => {
    if (key.upArrow) moveSelection(-1);
    else if (key.downArrow) moveSelection(1);
    else if (key.leftArrow) {
      if (stage === "config" && (configRow === "environment" || configRow === "model" || configRow === "effort" || configRow === "thinking")) {
        changeConfigValue(-1);
      } else {
        back();
      }
    } else if (key.rightArrow && stage === "config") {
      changeConfigValue(1);
    } else if (key.return) advance();
    void input;
  });

  const configChoices: ButtonChoice<ConfigRow>[] = CONFIG_ROWS.map((row) => ({
    ...row,
    label: `${row.label.padEnd(12)} ${configValue(row.value, {
      modeLabel: MODES[clampIndex(modeIndex, MODES.length)]!.label,
      modelLabel: modelChoice.label,
      effortLabel: effort.label,
      thinkingLabel: thinking.label,
    })}`,
  }));

  const currentOptions = stage === "agent"
    ? optionRows("agent", agentChoices, clampIndex(agentIndex, agentChoices.length))
    : optionRows("config", configChoices, clampIndex(configRowIndex, configChoices.length));

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text color={IR} bold>
        BENCH·AGI - launch setup
      </Text>
      <Box marginBottom={1}>
        <Text color={DIM}>Use only arrow keys and Enter. Choose an agent, then configure the environment and settings.</Text>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {summaryRow(
          "Agent",
          agentChoices[clampIndex(agentIndex, agentChoices.length)]!.value === "exit" ? "Exit Launcher" : `${agent.emoji} ${agent.name}`,
          stage === "agent",
        )}
        {summaryRow("Env", MODES[clampIndex(modeIndex, MODES.length)]!.label, stage === "config" && configRow === "environment")}
        {summaryRow("Model", modelChoice.label, stage === "config" && configRow === "model")}
        {summaryRow("Effort", effort.label, stage === "config" && configRow === "effort")}
        {summaryRow("Thinking", thinking.label, stage === "config" && configRow === "thinking")}
      </Box>
      <Box flexDirection="column" marginTop={1}>
        <Text color={IR} bold>{stage === "agent" ? "Step 1/2: Agent" : "Step 2/2: Environment & Settings"}</Text>
        {currentOptions}
      </Box>
      <Box marginTop={1}>
        <Text color={DIM}>
          {stage === "agent"
            ? "Up/Down select agent · Enter continue"
            : "Up/Down select row · Left/Right change value · Enter continue/launch"}
        </Text>
      </Box>
    </Box>
  );
}

export function runPicker(agents: LauncherAgent[], opts: PickerOpts = {}): Promise<PickerChoice> {
  return new Promise((resolve) => {
    let choice: PickerChoice = { mode: "quit" };
    const app = render(<Picker agents={agents} opts={opts} onSelect={(c) => (choice = c)} />, { stdout: process.stderr });
    void app.waitUntilExit().then(() => resolve(choice));
  });
}
