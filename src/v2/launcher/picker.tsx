// picker.tsx — the BenchAGI agent picker (ink). Renders to stderr so stdout
// stays clean. Returns the chosen agent + connection mode.

import { useState } from "react";
import { Box, Text, render, useApp, useInput } from "ink";

import type { LauncherAgent } from "./roster.js";

export interface PickerChoice {
  mode: "tunnel" | "direct" | "local-claude" | "local-codex" | "quit";
  agent?: LauncherAgent;
}

const IR = "#ff2d55";
const DIM = "#7c7c87";

function Picker({ agents, onSelect }: { agents: LauncherAgent[]; onSelect: (c: PickerChoice) => void }): JSX.Element {
  const { exit } = useApp();
  const [index, setIndex] = useState(0);

  useInput((input, key) => {
    if (key.upArrow || input === "k") setIndex((i) => (i - 1 + agents.length) % agents.length);
    else if (key.downArrow || input === "j") setIndex((i) => (i + 1) % agents.length);
    else if (key.return) {
      onSelect({ mode: "tunnel", agent: agents[index] });
      exit();
    } else if (input === "l") {
      onSelect({ mode: "local-claude", agent: agents[index] });
      exit();
    } else if (input === "x") {
      onSelect({ mode: "local-codex", agent: agents[index] });
      exit();
    } else if (input === "d") {
      onSelect({ mode: "direct", agent: agents[index] });
      exit();
    } else if (input === "q" || key.escape) {
      onSelect({ mode: "quit" });
      exit();
    }
  });

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text color={IR} bold>
        BENCH·AGI — choose an agent
      </Text>
      <Box marginBottom={1}>
        <Text color={DIM}>tunnel = Bench harness · direct = gateway URL · local = Claude Code or Codex CLI</Text>
      </Box>
      {agents.map((a, i) => {
        const sel = i === index;
        const label = `${a.emoji} ${a.name.padEnd(10)} ${a.role.padEnd(14)} ${a.modelShort}`;
        return (
          <Text key={a.agentId} color={sel ? IR : undefined} bold={sel} dimColor={!sel}>
            {`${sel ? " ▸ " : "   "}${label}`}
          </Text>
        );
      })}
      <Box marginTop={1}>
        <Text color={DIM}>↑/↓ move · enter tunnel · d direct · l Claude Code · x Codex CLI · q quit</Text>
      </Box>
    </Box>
  );
}

export function runPicker(agents: LauncherAgent[]): Promise<PickerChoice> {
  return new Promise((resolve) => {
    let choice: PickerChoice = { mode: "quit" };
    const app = render(<Picker agents={agents} onSelect={(c) => (choice = c)} />, { stdout: process.stderr });
    void app.waitUntilExit().then(() => resolve(choice));
  });
}
