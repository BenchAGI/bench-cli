// Raw ANSI primitives. ADR-001 — no TUI framework.

export const isTTY = process.stdout.isTTY === true;
export const noColor = process.env.NO_COLOR != null && process.env.NO_COLOR !== "";

const useAnsi = isTTY && !noColor;

function wrap(open: string, close: string, text: string): string {
  return useAnsi ? `${open}${text}${close}` : text;
}

export const c = {
  reset: (t: string) => wrap("\x1b[0m", "", t),
  bold: (t: string) => wrap("\x1b[1m", "\x1b[22m", t),
  dim: (t: string) => wrap("\x1b[2m", "\x1b[22m", t),
  italic: (t: string) => wrap("\x1b[3m", "\x1b[23m", t),
  red: (t: string) => wrap("\x1b[31m", "\x1b[39m", t),
  green: (t: string) => wrap("\x1b[32m", "\x1b[39m", t),
  yellow: (t: string) => wrap("\x1b[33m", "\x1b[39m", t),
  blue: (t: string) => wrap("\x1b[34m", "\x1b[39m", t),
  magenta: (t: string) => wrap("\x1b[35m", "\x1b[39m", t),
  cyan: (t: string) => wrap("\x1b[36m", "\x1b[39m", t),
  grey: (t: string) => wrap("\x1b[90m", "\x1b[39m", t),
};

// BenchAGI brand palette — single source of truth (was duplicated in cloud-seat.ts + picker.tsx).
// Hex for ink (<Text color>); raw truecolor codes + wrappers for hand-built strings (liveness, the
// readline status line). Wrappers respect NO_COLOR/TTY via the same `useAnsi` gate as `c`.
export const BRAND_HEX = {
  infrared: "#ff2d55",
  copper: "#c47a3a",
  amber: "#ffb84a",
  dim: "#7c7c87",
} as const;

export const BRAND = {
  infrared: "\x1b[38;2;255;45;85m",
  copper: "\x1b[38;2;196;122;58m",
  amber: "\x1b[38;2;255;184;74m",
  dim: "\x1b[38;2;124;124;135m",
  reset: "\x1b[0m",
} as const;

export const brand = {
  ir: (t: string) => wrap(BRAND.infrared, "\x1b[39m", t),
  copper: (t: string) => wrap(BRAND.copper, "\x1b[39m", t),
  amber: (t: string) => wrap(BRAND.amber, "\x1b[39m", t),
  sdim: (t: string) => wrap(BRAND.dim, "\x1b[39m", t),
};

// Cursor control — only effective in TTY mode.
export const cursor = {
  hide: () => useAnsi && process.stdout.write("\x1b[?25l"),
  show: () => useAnsi && process.stdout.write("\x1b[?25h"),
  up: (n = 1) => useAnsi && process.stdout.write(`\x1b[${n}A`),
  down: (n = 1) => useAnsi && process.stdout.write(`\x1b[${n}B`),
  toColumn: (col: number) => useAnsi && process.stdout.write(`\x1b[${col}G`),
  clearLine: () => useAnsi && process.stdout.write("\x1b[2K\r"),
  saveCursor: () => useAnsi && process.stdout.write("\x1b[s"),
  restoreCursor: () => useAnsi && process.stdout.write("\x1b[u"),
};

export function termWidth(): number {
  return process.stdout.columns || 80;
}

// Output-sink seam. When a sink is installed (the ink TUI does this), all renderer output —
// println/writeRaw (stdout) AND eprintln (stderr notices) — flows into it instead of the terminal,
// so ink owns the screen. Default (null) = normal stream behavior for the readline / non-TTY path.
export type LogSink = (chunk: string) => void;
let logSink: LogSink | null = null;
export function setLogSink(sink: LogSink | null): void {
  logSink = sink;
}

export function println(text = ""): void {
  if (logSink) logSink(`${text}\n`);
  else process.stdout.write(`${text}\n`);
}

export function writeRaw(text: string): void {
  if (logSink) logSink(text);
  else process.stdout.write(text);
}

export function eprintln(text = ""): void {
  if (logSink) logSink(`${text}\n`);
  else process.stderr.write(`${text}\n`);
}

// Truncate to N display chars (rough — counts chars, not graphemes).
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + "…";
}

// Restore cursor display on exit; install once.
let cursorRestored = false;
export function ensureCursorRestoredOnExit(): void {
  if (cursorRestored) return;
  cursorRestored = true;
  const restore = () => cursor.show();
  process.on("exit", restore);
  process.on("SIGINT", () => {
    restore();
    process.exit(130);
  });
  process.on("SIGTERM", () => {
    restore();
    process.exit(143);
  });
}
