// highlight.ts — lightweight inline formatting for streamed agent output, the way Claude Code draws
// the eye to important things: clickable links, inline `code`, **bold**, dates, and money.
//
// Applied per committed line at render time. It is ANSI-AWARE: the renderer already wraps prefixes
// (e.g. "Aurelius> " in infrared) in escape codes, so we skip over existing escape/OSC sequences and
// only decorate the plain-text runs between them — never matching inside an escape code.

import { isTTY, noColor } from "./ansi.js";

const useAnsi = isTTY && !noColor;

// Existing escape sequences to pass through untouched: SGR colors + OSC-8 hyperlinks (either
// terminator: BEL \x07 or ST \x1b\\).
const PASSTHROUGH = /\x1b\[[0-9;]*m|\x1b\]8;;.*?(?:\x07|\x1b\\)/g;

// One pass over a plain run: first-match-wins so rules never nest (a date inside a URL stays a URL).
// Groups: 1=url · 2=code inner · 3=bold inner · 4=money · 5=ISO date.
const RULES = /(https?:\/\/[^\s)\]]+)|`([^`]+)`|\*\*([^*]+)\*\*|(\$\d[\d,]*(?:\.\d{1,2})?)|(\b\d{4}-\d{2}-\d{2}\b)/g;

// Truecolor SGR helpers (used only when color is on).
const LINK = "\x1b[4;38;2;255;107;138m"; // underline + light infrared
const CODE = "\x1b[38;2;196;122;58m"; // copper
const MONEY = "\x1b[38;2;70;211;105m"; // green
const DATE = "\x1b[38;2;255;184;74m"; // amber
const BOLD = "\x1b[1m";
const OFF = "\x1b[0m";

function osc8(url: string, label: string): string {
  // Clickable hyperlink (OSC 8). Falls back to plain coloring where unsupported — the label still
  // shows; non-supporting terminals just ignore the wrapper.
  return `\x1b]8;;${url}\x07${LINK}${label}${OFF}\x1b]8;;\x07`;
}

function decorate(run: string): string {
  return run.replace(RULES, (_full, url, code, bold, money, date) => {
    if (url) return useAnsi ? osc8(url, url) : url;
    if (code != null) return useAnsi ? `${CODE}${code}${OFF}` : code; // strip backticks either way
    if (bold != null) return useAnsi ? `${BOLD}${bold}${OFF}` : bold; // strip ** either way
    if (money) return useAnsi ? `${MONEY}${money}${OFF}` : money;
    if (date) return useAnsi ? `${DATE}${date}${OFF}` : date;
    return _full;
  });
}

// --- fenced code blocks ----------------------------------------------------
// Detect ``` fences across a list of committed lines and classify each line, so the TUI can frame
// code blocks (gutter + section borders) and syntax-highlight their contents. Fence state is tracked
// across the whole list so a window scrolled into the middle of a block still renders as code.

export type LineKind = { kind: "open" | "close" | "code" | "text"; lang?: string };

export function annotateCodeBlocks(lines: string[]): LineKind[] {
  const out: LineKind[] = [];
  let inFence = false;
  let lang = "";
  for (const line of lines) {
    const t = line.replace(PASSTHROUGH, "").trim();
    const m = /^```+(\w*)$/.exec(t);
    if (m) {
      if (!inFence) {
        inFence = true;
        lang = m[1] ?? "";
        out.push({ kind: "open", lang });
      } else {
        inFence = false;
        out.push({ kind: "close", lang });
      }
    } else {
      out.push(inFence ? { kind: "code", lang } : { kind: "text" });
    }
  }
  return out;
}

// Generic, language-agnostic syntax coloring for a code line: strings (green), comments (dim),
// a common keyword set (infrared), numbers (amber). First-match-wins so keywords inside strings or
// comments aren't recolored. No-ops (returns the text) when color is off.
const CODE_TOKENS =
  /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|(\/\/[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\/)|(\b(?:function|const|let|var|return|if|else|elif|for|while|do|switch|case|break|continue|import|export|from|default|class|extends|super|new|async|await|yield|try|catch|finally|throw|typeof|instanceof|delete|void|in|of|def|lambda|pass|with|as|and|or|not|is|None|True|False|null|undefined|true|false|fn|pub|use|struct|impl|match|mut|self|enum|trait|public|private|protected|static|int|float|bool|str|string|number|boolean|print|println|echo|func|package|type)\b)|(\b\d+(?:\.\d+)?\b)/g;
const KW = "\x1b[38;2;255;45;85m"; // infrared
const STR = "\x1b[38;2;70;211;105m"; // green
const NUM = "\x1b[38;2;255;184;74m"; // amber
const CMT = "\x1b[2m"; // dim

export function highlightCode(text: string): string {
  if (!useAnsi || !text) return text;
  return text.replace(CODE_TOKENS, (full, str, cmt, kw, num) => {
    if (str) return `${STR}${str}\x1b[0m`;
    if (cmt) return `${CMT}${cmt}\x1b[0m`;
    if (kw) return `${KW}${kw}\x1b[0m`;
    if (num) return `${NUM}${num}\x1b[0m`;
    return full;
  });
}

// Decorate a single line, preserving any escape/OSC sequences already in it.
export function highlight(line: string): string {
  if (!line) return line;
  let out = "";
  let last = 0;
  let m: RegExpExecArray | null;
  PASSTHROUGH.lastIndex = 0;
  while ((m = PASSTHROUGH.exec(line))) {
    out += decorate(line.slice(last, m.index));
    out += m[0]; // passthrough the escape sequence verbatim
    last = PASSTHROUGH.lastIndex;
  }
  out += decorate(line.slice(last));
  return out;
}
