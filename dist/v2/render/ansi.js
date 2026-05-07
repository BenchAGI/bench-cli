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
export function println(text = "") {
    process.stdout.write(`${text}\n`);
}
export function writeRaw(text) {
    process.stdout.write(text);
}
export function eprintln(text = "") {
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
