// Terminal control helpers for the full-screen TUI.

type WritableTty = {
  isTTY?: boolean;
  write: (chunk: string) => unknown;
};

const ENTER_ALT_SCREEN = "\x1b[?1049h\x1b[2J\x1b[H";
const EXIT_ALT_SCREEN = "\x1b[?1049l";
const ENABLE_MOUSE = "\x1b[?1000h\x1b[?1006h";
const DISABLE_MOUSE = "\x1b[?1006l\x1b[?1000l";

const SGR_MOUSE_RE = /\x1b\[<(\d+);\d+;\d+[mM]/g;
const X10_MOUSE_PREFIX = "\x1b[M";

function wheelDirection(buttonCode: number): number {
  if ((buttonCode & 64) !== 64) return 0;
  return (buttonCode & 1) === 0 ? 1 : -1;
}

export function mouseWheelDelta(input: string): number {
  let delta = 0;
  for (const match of input.matchAll(SGR_MOUSE_RE)) {
    delta += wheelDirection(Number(match[1]));
  }
  for (let index = input.indexOf(X10_MOUSE_PREFIX); index >= 0; index = input.indexOf(X10_MOUSE_PREFIX, index + 1)) {
    if (index + 5 >= input.length) continue;
    delta += wheelDirection(input.charCodeAt(index + 3) - 32);
  }
  return delta;
}

export function containsMouseEvent(input: string): boolean {
  return /\x1b\[<\d+;\d+;\d+[mM]/.test(input) || input.includes(X10_MOUSE_PREFIX);
}

export function installTuiScreenMode(stdout: WritableTty = process.stdout): () => void {
  if (!stdout.isTTY || process.env.BENCHAGI_TUI_NATIVE_SCROLLBACK === "1") return () => undefined;
  stdout.write(ENTER_ALT_SCREEN + ENABLE_MOUSE);
  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    stdout.write(DISABLE_MOUSE + EXIT_ALT_SCREEN);
  };
}
