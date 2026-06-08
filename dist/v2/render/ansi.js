// Raw ANSI primitives. ADR-001 — no TUI framework.
export const isTTY = process.stdout.isTTY === true;
export const noColor = process.env.NO_COLOR != null && process.env.NO_COLOR !== "";
const useAnsi = isTTY && !noColor;
function wrap(open, close, text) {
    return useAnsi ? `${open}${text}${close}` : text;
}
export const c = {
    reset: (t) => wrap("\x1b[0m", "", t),
    bold: (t) => wrap("\x1b[1m", "\x1b[22m", t),
    dim: (t) => wrap("\x1b[2m", "\x1b[22m", t),
    italic: (t) => wrap("\x1b[3m", "\x1b[23m", t),
    red: (t) => wrap("\x1b[31m", "\x1b[39m", t),
    green: (t) => wrap("\x1b[32m", "\x1b[39m", t),
    yellow: (t) => wrap("\x1b[33m", "\x1b[39m", t),
    blue: (t) => wrap("\x1b[34m", "\x1b[39m", t),
    magenta: (t) => wrap("\x1b[35m", "\x1b[39m", t),
    cyan: (t) => wrap("\x1b[36m", "\x1b[39m", t),
    grey: (t) => wrap("\x1b[90m", "\x1b[39m", t),
};
// BenchAGI brand palette — single source of truth (was duplicated in cloud-seat.ts + picker.tsx).
// Hex for ink (<Text color>); raw truecolor codes + wrappers for hand-built strings (liveness, the
// readline status line). Wrappers respect NO_COLOR/TTY via the same `useAnsi` gate as `c`.
export const BRAND_HEX = {
    infrared: "#ff2d55",
    copper: "#c47a3a",
    amber: "#ffb84a",
    dim: "#7c7c87",
};
export const BRAND = {
    infrared: "\x1b[38;2;255;45;85m",
    copper: "\x1b[38;2;196;122;58m",
    amber: "\x1b[38;2;255;184;74m",
    dim: "\x1b[38;2;124;124;135m",
    reset: "\x1b[0m",
};
export const brand = {
    ir: (t) => wrap(BRAND.infrared, "\x1b[39m", t),
    copper: (t) => wrap(BRAND.copper, "\x1b[39m", t),
    amber: (t) => wrap(BRAND.amber, "\x1b[39m", t),
    sdim: (t) => wrap(BRAND.dim, "\x1b[39m", t),
};
// Cursor control — only effective in TTY mode.
export const cursor = {
    hide: () => useAnsi && process.stdout.write("\x1b[?25l"),
    show: () => useAnsi && process.stdout.write("\x1b[?25h"),
    up: (n = 1) => useAnsi && process.stdout.write(`\x1b[${n}A`),
    down: (n = 1) => useAnsi && process.stdout.write(`\x1b[${n}B`),
    toColumn: (col) => useAnsi && process.stdout.write(`\x1b[${col}G`),
    clearLine: () => useAnsi && process.stdout.write("\x1b[2K\r"),
    saveCursor: () => useAnsi && process.stdout.write("\x1b[s"),
    restoreCursor: () => useAnsi && process.stdout.write("\x1b[u"),
};
export function termWidth() {
    return process.stdout.columns || 80;
}
let logSink = null;
export function setLogSink(sink) {
    logSink = sink;
}
export function println(text = "") {
    if (logSink)
        logSink(`${text}\n`);
    else
        process.stdout.write(`${text}\n`);
}
export function writeRaw(text) {
    if (logSink)
        logSink(text);
    else
        process.stdout.write(text);
}
export function eprintln(text = "") {
    if (logSink)
        logSink(`${text}\n`);
    else
        process.stderr.write(`${text}\n`);
}
// Truncate to N display chars (rough — counts chars, not graphemes).
export function truncate(text, max) {
    if (text.length <= max)
        return text;
    return text.slice(0, max - 1) + "…";
}
// Restore cursor display on exit; install once.
let cursorRestored = false;
export function ensureCursorRestoredOnExit() {
    if (cursorRestored)
        return;
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
