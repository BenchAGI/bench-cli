// Slash-command registry + parser. Framework-agnostic so both the readline fallback and the ink
// TUI consume the same surface. Each command here maps to an existing ChatRunner/state method in the
// TUI's dispatch table — this module owns *what* the commands are, not *what they do*.
// v1 command set (see plan "Slash commands"). The TUI binds each to an action.
export const SLASH_COMMANDS = [
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
// Generated-product parity commands. Their implementation is transport-neutral:
// ExcaliburSidecarRuntime serves these through the same validated control reads
// used by the top-level CLI commands.
export const EXCALIBUR_SLASH_COMMANDS = [
    { name: "might", summary: "Show MIGHT posture and capability-specific health" },
    {
        name: "orchestra",
        usage: "/orchestra init <absolute-mission-json> | status <mission-id> | advance <mission-id> <exact-mission-digest> | propose <mission-id> <absolute-details-json>",
        summary: "Run one pinned Pattern A mission through its exact draft-publication proposal",
    },
    { name: "pulse", summary: "Show the authoritative Pulse observation" },
    { name: "decisions", summary: "Show approval and decision aggregates" },
    { name: "forge", summary: "Show Forge observation and dispatch posture" },
    { name: "comms", summary: "Show count-only communications and crew state" },
    { name: "schedules", summary: "Show schedule aggregates" },
    { name: "fleet", summary: "Show Fleet observation and authority posture" },
    { name: "receipts", summary: "Show deterministic execution receipts" },
    { name: "controls", summary: "Show capabilities and every blocking gate" },
    { name: "system", summary: "Show protocol, manifest, and runtime status" },
    { name: "context", summary: "Show the explicit operator or tenant context" },
    { name: "seat", summary: "Show the attested conductor seat" },
    { name: "route", summary: "Show the digest-pinned routing profile" },
    { name: "memory", summary: "Show the current memory boundary" },
];
// Parse a line as a slash command. Returns null when the line is NOT a slash command:
// it must start with `/` after optional leading whitespace. A bare "/" parses to name "".
export function parseSlash(line) {
    const left = line.replace(/^\s+/, "");
    if (!left.startsWith("/"))
        return null;
    const body = left.slice(1);
    const match = body.match(/^(\S*)\s*([\s\S]*)$/);
    const name = (match?.[1] ?? "").toLowerCase();
    const argStr = (match?.[2] ?? "").trim();
    const args = argStr.length ? argStr.split(/\s+/) : [];
    return { name, args, argStr, raw: line };
}
export function buildRegistry(extra = []) {
    return [...SLASH_COMMANDS, ...extra];
}
// Resolve a command by canonical name or alias (case-insensitive). Null if unknown.
export function findCommand(name, registry = SLASH_COMMANDS) {
    const n = name.toLowerCase();
    for (const cmd of registry) {
        if (cmd.name === n)
            return cmd;
        if (cmd.aliases?.some((a) => a.toLowerCase() === n))
            return cmd;
    }
    return null;
}
// Live-hint matcher for the input bar. While typing the command word, return candidates whose
// name/alias is a prefix of the fragment. "" or "/" → all visible commands. Once a space is typed
// (the user has moved on to args), stop hinting.
export function matchHint(partial, registry = SLASH_COMMANDS) {
    const left = partial.replace(/^\s+/, "");
    if (!left.startsWith("/"))
        return [];
    const body = left.slice(1);
    if (/\s/.test(body))
        return [];
    const frag = body.toLowerCase();
    return registry.filter((cmd) => {
        if (cmd.hidden)
            return false;
        if (!frag)
            return true;
        return [cmd.name, ...(cmd.aliases ?? [])].some((n) => n.startsWith(frag));
    });
}
// Render the /help listing — one command per line, aliases + usage shown, summaries aligned.
export function renderHelp(registry = SLASH_COMMANDS) {
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
