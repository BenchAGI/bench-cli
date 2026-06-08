// app.tsx — the full-screen ink cloud-chat shell. A scrolling output pane (committed lines flow into
// native scrollback via <Static>) + a live in-progress region (streamed assistant/thinking) + the
// 🦅 working indicator + the pinned input row + the dense pinned status bar. Renderer output reaches
// the screen via the ansi log sink → LogStore (set up in runTui); ink owns stdout directly.

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Box, Text, render, useApp, useInput } from "ink";

import { c, setLogSink, BRAND_HEX } from "../render/ansi.js";
import { highlight } from "../render/highlight.js";
import { CLI_VERSION } from "../commands/version.js";
import type { ChatRunner } from "../chat-runner.js";
import { parseSlash, findCommand, renderHelp, SLASH_COMMANDS } from "../repl/slash.js";
import type { ThinkingMode } from "../render/stream.js";
import { LogStore } from "./log-store.js";
import { StatusBar, type HealthState } from "./status-bar.js";
import { Working } from "./working.js";
import { Input, slashMenuRows } from "./input.js";
import { initInput, type InputState } from "./input-model.js";

export type TuiProps = {
  runner: ChatRunner;
  store: LogStore;
  agentId: string;
  model?: string; // already shortened, e.g. "Opus 4.8"
  tier?: { level: string; color?: string };
  who?: string;
  clearScreen?: () => void; // wipes the rendered frame (ink instance clear) — for /clear
};

const POLL_MS = 250;

function termCols(): number {
  return process.stdout.columns || 80;
}
function termRows(): number {
  return process.stdout.rows || 24;
}

const ANSI_RE = /\x1b\[[0-9;]*m/g;
function displayWidth(s: string): number {
  return s.replace(ANSI_RE, "").length;
}

// Pick the lines that fit `budgetRows` once wrapping at `cols` is accounted for, so the framed
// viewport never overflows (overflow would scroll the terminal and unpin the bottom bar). `scroll`
// is how many lines up from the live bottom to anchor (0 = following the latest output).
function visibleTail(items: string[], cols: number, budgetRows: number, scroll = 0): string[] {
  const out: string[] = [];
  let used = 0;
  const inner = Math.max(1, cols - 2); // paddingX={1}
  const end = Math.max(0, items.length - scroll); // exclusive index of the last visible line
  for (let i = end - 1; i >= 0; i--) {
    const rows = Math.max(1, Math.ceil(displayWidth(items[i]!) / inner));
    if (out.length > 0 && used + rows > budgetRows) break;
    out.unshift(items[i]!);
    used += rows;
  }
  return out;
}

const MODEL_SHORT: Record<string, string> = {
  "claude-opus-4-8": "Opus 4.8",
  "claude-opus-4-6": "Opus 4.6",
  "claude-sonnet-4-6": "Sonnet 4.6",
  "claude-haiku-4-5": "Haiku 4.5",
};
function shortenModel(m: string): string {
  const k = m.replace(/^anthropic\//, "");
  return MODEL_SHORT[k] ?? m;
}
const THINK_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export function App(props: TuiProps): JSX.Element {
  const { runner, store, agentId, tier } = props;
  const [model, setModelState] = useState(props.model); // mutable via /model over the flyway
  const { exit } = useApp();

  // Who's typing — the user's first name (falls back to "you").
  const me = props.who?.trim().split(/\s+/)[0] || "you";
  const agentColor = BRAND_HEX.infrared; // the agent's signature color (frames the text area)

  // Output buffer (external store) → committed lines + live pending region.
  useSyncExternalStore(store.subscribe, store.getVersion);
  const { lines, pending } = store.snapshot();

  // Live runtime state, polled from the runner (no event-emitter refactor needed).
  const [busy, setBusy] = useState(false);
  const [runId, setRunId] = useState("idle");
  const [health, setHealth] = useState<HealthState>("ok");
  const [healthNote, setHealthNote] = useState<string | undefined>(undefined);
  const [approval, setApproval] = useState(false);
  const [thinking, setThinking] = useState<ThinkingMode>(runner.getThinking());
  const [sessionShort, setSessionShort] = useState<string | undefined>(undefined);
  const [width, setWidth] = useState(termCols());
  const [height, setHeight] = useState(termRows());
  const [scroll, setScroll] = useState(0); // lines scrolled up from the live bottom (0 = following)
  const [istate, setIstate] = useState<InputState>(() => initInput()); // lifted so layout fits the menu

  useEffect(() => {
    const tick = (): void => {
      const h = runner.healthSnapshot();
      setBusy(runner.isInFlight());
      setHealth(h.state);
      setApproval(runner.hasPendingApproval());
      setThinking(runner.getThinking());
      const id = runner.currentRun();
      if (id) setRunId(id);
      setHealthNote(
        h.state === "reconnecting"
          ? "reconnecting…"
          : h.state === "stuck"
            ? "still working — Ctrl-C to abort"
            : undefined,
      );
      const key = runner.resumeKey();
      setSessionShort(key && key !== `agent:${agentId}` ? key.replace(/^agent:/, "").slice(-12) : undefined);
    };
    tick();
    const t = setInterval(tick, POLL_MS);
    return () => clearInterval(t);
  }, [runner, agentId]);

  useEffect(() => {
    const onResize = (): void => {
      setWidth(termCols());
      setHeight(termRows());
    };
    process.stdout.on("resize", onResize);
    return () => {
      process.stdout.off("resize", onResize);
    };
  }, []);

  const sendingRef = useRef(false);

  const handleSubmit = (line: string): void => {
    const parsed = parseSlash(line);
    if (parsed) {
      void handleSlash(parsed.name, parsed.args);
      return;
    }
    // Guard BEFORE echoing — the runner rejects a second concurrent send, so echoing first would
    // print `you> …` and then silently drop the message (review finding #3/#5).
    if (sendingRef.current || runner.isInFlight()) {
      store.pushLine(c.dim("(turn still in flight — Ctrl-C to abort before sending another)"));
      return;
    }
    setScroll(0); // sending snaps back to the live bottom
    store.pushLine(""); // blank line above your message
    store.pushLine(c.cyan(`${me}> `) + line); // e.g. "Cory> measure 123 Main"
    store.pushLine(""); // blank line below it → his reply isn't pressed against yours
    void (async () => {
      sendingRef.current = true;
      setBusy(true);
      try {
        const id = await runner.sendMessage(line);
        if (id) {
          setRunId(id);
          await runner.waitForFinal(30 * 60_000, id);
        }
      } finally {
        sendingRef.current = false;
        setBusy(runner.isInFlight());
      }
    })();
  };

  const handleSlash = async (name: string, args: string[]): Promise<void> => {
    const cmd = findCommand(name);
    if (!cmd) {
      store.pushLine(c.dim(`(unknown command: /${name} — try /help)`));
      return;
    }
    switch (cmd.name) {
      case "help":
        store.pushLine(c.bold("commands:"));
        store.pushLine(renderHelp());
        break;
      case "status":
        for (const l of statusLines()) store.pushLine(l);
        break;
      case "thinking": {
        const arg = (args[0] ?? "").toLowerCase();
        let next: ThinkingMode;
        if (arg === "on" || arg === "off" || arg === "collapsed") next = arg;
        else next = runner.getThinking() === "on" ? "off" : "on"; // no arg → toggle
        runner.setThinking(next);
        setThinking(next);
        store.pushLine(c.dim(`(thinking: ${next})`));
        break;
      }
      case "expand":
        await runner.handleApprovalKey("r"); // toggles full tool output, prints the new state
        break;
      case "interrupt": {
        const reason = await runner.interruptCurrent();
        store.pushLine(c.dim(reason === "denied" ? "(approval denied)" : "(aborted)"));
        break;
      }
      case "clear":
        store.clear(); // remounts <Static> empty (generation bump)
        props.clearScreen?.(); // wipe the rendered frame too
        break;
      case "switch":
        if (args[0]) {
          store.pushLine(c.dim(`(agent switch is a relaunch for now — exit and run:  benchagi ${args[0]})`));
        } else {
          store.pushLine(c.dim("(usage: /switch <agent> — relaunches the seat; hot-swap is coming)"));
        }
        break;
      case "model": {
        if (args[0]) {
          const ok = await runner.setModel(args[0]);
          if (ok) {
            setModelState(shortenModel(args[0]));
            store.pushLine(c.dim(`(model → ${args[0]}${runner.hasSession() ? "" : " — applies to this chat"})`));
          } else {
            store.pushLine(c.dim("(can't switch model mid-chat over the flyway — set /model before your first message, or use Flyway·deep)"));
          }
        } else {
          store.pushLine(c.dim(`(model: ${shortenModel(runner.currentModel() || "default")} — /model <id> to switch, before your first message)`));
        }
        break;
      }
      case "effort": {
        const lvl = (args[0] ?? "").toLowerCase();
        if (!lvl) {
          store.pushLine(c.dim(`(thinking level — usage: /effort <${THINK_LEVELS.join("|")}>)`));
          break;
        }
        if (!THINK_LEVELS.includes(lvl)) {
          store.pushLine(c.dim(`(unknown level '${lvl}' — try: ${THINK_LEVELS.join(", ")})`));
          break;
        }
        const ok = await runner.setThinkingLevel(lvl);
        store.pushLine(
          ok
            ? c.dim(`(thinking level → ${lvl})`)
            : c.dim("(thinking level is the brain's default over the flyway — use Flyway·deep for /effort control)"),
        );
        break;
      }
      case "exit":
        cleanupAndExit();
        break;
    }
  };

  function statusLines(): string[] {
    const h = runner.healthSnapshot();
    const tierStr = tier?.level ? `${tier.level}${tier.color ? ` (${tier.color})` : ""}` : "—";
    const sess = runner.resumeKey() ?? "—";
    return [
      `${c.bold("🦅 " + cap(agentId))}  ${model ?? ""}  ${tierStr}`,
      c.dim(`session: ${sess} · health: ${h.state} · thinking: ${runner.getThinking()} · expand: ${runner.isExpanded() ? "on" : "off"}`),
    ];
  }

  function cleanupAndExit(): void {
    exit();
  }

  // Bottom-anchored: the framed text area fills the screen and the conversation emerges from just
  // above the input. Show the lines that fit; older lines scroll off the top (PgUp to reveal).
  const items = pending.length > 0 ? lines.concat(pending) : lines;
  const menuRows = slashMenuRows(istate.buffer, SLASH_COMMANDS); // shrink the viewport to fit the slash menu
  const budget = Math.max(3, height - 7 - menuRows); // reserve: 2 brake lines + working + input + status(2) + menu
  const maxScroll = Math.max(0, items.length - budget);
  const sc = Math.min(scroll, maxScroll); // clamped so the viewport never goes blank
  const pageStep = Math.max(1, budget - 2);
  const visible = visibleTail(items, width, budget, sc);

  // PgUp/PgDn scroll the history. (App-level useInput coexists with the input editor's; neither
  // consumes the other's keys — PgUp/PgDn aren't printable and the editor ignores them.)
  useInput((_input, key) => {
    if (key.pageUp) setScroll(() => Math.min(maxScroll, sc + pageStep));
    else if (key.pageDown) setScroll(() => Math.max(0, sc - pageStep));
  });

  // While scrolled up, keep the viewport anchored to the same content as new lines commit below.
  const prevLen = useRef(items.length);
  useEffect(() => {
    const grew = items.length - prevLen.current;
    prevLen.current = items.length;
    if (grew > 0) setScroll((s) => (s > 0 ? s + grew : 0));
  }, [items.length]);

  return (
    <Box flexDirection="column" height={height}>
      <Box
        flexGrow={1}
        flexDirection="column"
        justifyContent="flex-end"
        borderStyle="single"
        borderColor={agentColor}
        borderTop={true}
        borderBottom={true}
        borderLeft={false}
        borderRight={false}
        paddingX={1}
      >
        {visible.map((line, i) => (
          // Render empty lines as a space so ink gives them height — preserves paragraph breaks
          // (a bare empty <Text> collapses to zero rows and mushes paragraphs together).
          // highlight() decorates links/code/bold/dates/money (ANSI-aware: existing colors kept).
          <Text key={i}>{line.length > 0 ? highlight(line) : " "}</Text>
        ))}
      </Box>
      {sc > 0 ? (
        <Text color={BRAND_HEX.amber}>{`  ↑ ${sc} earlier line${sc === 1 ? "" : "s"} · PgDn to come back · send → live`}</Text>
      ) : null}
      <Working active={busy} runId={runId} note={healthNote} />
      <Input
        state={istate}
        onChange={setIstate}
        busy={busy}
        approvalActive={approval}
        // Only consume a/d/r as control keys while a run is in flight (mirrors the readline `busy`
        // guard in prompt.ts) — otherwise 'r' (expand toggle) would eat the first letter of an idle
        // message like "roof"/"remove". Live isInFlight() check, no 250ms-polled staleness.
        canConsumeKey={(key) => runner.isInFlight() && runner.canHandleApprovalKey(key)}
        registry={SLASH_COMMANDS}
        onSubmit={handleSubmit}
        onApproval={(key) => void runner.handleApprovalKey(key)}
        onInterrupt={() => void runner.interruptCurrent()}
        onExit={cleanupAndExit}
      />
      <StatusBar
        state={{
          agentId,
          model,
          tier,
          sessionShort,
          health,
          pendingApproval: approval,
          thinking,
          tokens: null, // dark until the gateway emits real usage — never fabricated
        }}
        width={width}
      />
    </Box>
  );
}

function cap(s: string): string {
  return s ? s[0]!.toUpperCase() + s.slice(1) : s;
}

// Launch the ink TUI: install the log sink so renderer output flows into the buffer, render the app,
// and restore the sink on exit. The caller (cloud-seat) owns runner.connect()/close().
export async function runTui(runner: ChatRunner, props: Omit<TuiProps, "store" | "runner">): Promise<void> {
  const store = new LogStore();
  store.pushLine(c.dim(`benchagi ${CLI_VERSION} · 🦅 type a message, /help for commands, /exit to quit`));
  setLogSink(store.write);
  // Holder so /clear can reach ink's instance.clear() (the instance doesn't exist until render()).
  let clearScreen = (): void => {};
  try {
    const app = render(
      <App runner={runner} store={store} {...props} clearScreen={() => clearScreen()} />,
      { exitOnCtrlC: false },
    );
    clearScreen = () => app.clear();
    await app.waitUntilExit();
  } finally {
    setLogSink(null);
  }
}
