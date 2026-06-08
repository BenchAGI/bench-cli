// Slash-command registry + parser. Framework-agnostic so both the readline fallback and the ink
// TUI consume the same surface. Each command here maps to an existing ChatRunner/state method in the
// TUI's dispatch table — this module owns *what* the commands are, not *what they do*.

export type SlashCommand = {
  name: string; // canonical, no leading slash, lowercase
  aliases?: string[]; // alternate names, no slash
  summary: string; // one-line help
  usage?: string; // e.g. "/thinking [on|off|collapsed]" (defaults to "/<name>")
  hidden?: boolean; // omit from hints + help listing
};

export type ParsedSlash = {
  name: string; // lowercased command word (no slash); "" for a bare "/"
  args: string[]; // whitespace-split remainder
  argStr: string; // trimmed raw remainder
  raw: string; // original line
};

// v1 command set (see plan "Slash commands"). The TUI binds each to an action.
export const SLASH_COMMANDS: readonly SlashCommand[] = [
  { name: "help", aliases: ["?"], summary: "Show available commands" },
  { name: "status", summary: "Show connection, agent, and session status" },
  {
    name: "thinking",
    usage: "/thinking [on|off|collapsed]",
    summary: "Toggle streamed agent reasoning",
  },
  { name: "expand", aliases: ["r"], summary: "Toggle full tool output vs. summarized" },
  { name: "interrupt", aliases: ["stop"], summary: "Interrupt the current run" },
  { name: "clear", summary: "Clear the screen (keeps the server session)" },
  { name: "switch", aliases: ["agent"], usage: "/switch <agent>", summary: "Switch agent (/agent lists)" },
  { name: "model", usage: "/model [id]", summary: "Show or switch the model (default Opus 4.8)" },
  {
    name: "effort",
    usage: "/effort [off|minimal|low|medium|high|xhigh|max]",
    summary: "Set the agent's thinking level",
  },
  { name: "exit", aliases: ["quit"], summary: "Leave the chat" },
];

// Parse a line as a slash command. Returns null when the line is NOT a slash command:
// it must start with `/` after optional leading whitespace. A bare "/" parses to name "".
export function parseSlash(line: string): ParsedSlash | null {
  const left = line.replace(/^\s+/, "");
  if (!left.startsWith("/")) return null;
  const body = left.slice(1);
  const match = body.match(/^(\S*)\s*([\s\S]*)$/);
  const name = (match?.[1] ?? "").toLowerCase();
  const argStr = (match?.[2] ?? "").trim();
  const args = argStr.length ? argStr.split(/\s+/) : [];
  return { name, args, argStr, raw: line };
}

export function buildRegistry(extra: SlashCommand[] = []): SlashCommand[] {
  return [...SLASH_COMMANDS, ...extra];
}

// Resolve a command by canonical name or alias (case-insensitive). Null if unknown.
export function findCommand(
  name: string,
  registry: readonly SlashCommand[] = SLASH_COMMANDS,
): SlashCommand | null {
  const n = name.toLowerCase();
  for (const cmd of registry) {
    if (cmd.name === n) return cmd;
    if (cmd.aliases?.some((a) => a.toLowerCase() === n)) return cmd;
  }
  return null;
}

// Live-hint matcher for the input bar. While typing the command word, return candidates whose
// name/alias is a prefix of the fragment. "" or "/" → all visible commands. Once a space is typed
// (the user has moved on to args), stop hinting.
export function matchHint(
  partial: string,
  registry: readonly SlashCommand[] = SLASH_COMMANDS,
): SlashCommand[] {
  const left = partial.replace(/^\s+/, "");
  if (!left.startsWith("/")) return [];
  const body = left.slice(1);
  if (/\s/.test(body)) return [];
  const frag = body.toLowerCase();
  return registry.filter((cmd) => {
    if (cmd.hidden) return false;
    if (!frag) return true;
    return [cmd.name, ...(cmd.aliases ?? [])].some((n) => n.startsWith(frag));
  });
}

// Render the /help listing — one command per line, aliases + usage shown, summaries aligned.
export function renderHelp(registry: readonly SlashCommand[] = SLASH_COMMANDS): string {
  const rows = registry
    .filter((c) => !c.hidden)
    .map((c) => {
      const usage = c.usage ?? `/${c.name}`;
      const alias = c.aliases?.length ? `  (/${c.aliases.join(", /")})` : "";
      return { left: usage + alias, summary: c.summary };
    });
  const width = rows.reduce((max, r) => Math.max(max, r.left.length), 0);
  return rows.map((r) => `  ${r.left.padEnd(width)}   ${r.summary}`).join("\n");
}
