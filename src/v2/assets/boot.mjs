#!/usr/bin/env node
// boot.mjs — BenchAGI boot cinematic: an animated "BENCH AGI" Infrared wordmark
// under a pixel-art eagle mascot. Pure Node (no PIL, no build step) — colour and
// animation are computed at runtime from scripts/bench-cli/boot-art.mjs.
//
// Capability ladder (first match wins):
//   1. non-TTY / piped / CI / --fast / NO_COLOR  -> one static frame (mono: zero escapes)
//   2. TTY + BENCH_BOOT_MOTION=off               -> final composed frame once, no motion
//   3. TTY, 256-colour only                      -> animated, xterm-256 palette
//   4. TTY + truecolor                           -> full cinematic
// Always restores the cursor + resets SGR on exit / SIGINT. Caps total runtime.
// Local-only (kestrel-aurelius perimeter).
import process from "node:process";

import {
  BRAND,
  EAGLE_PALETTE,
  GLYPHS,
  GLYPH_ROWS,
  IR_GRADIENT,
  TAGLINE,
  WORDMARK,
  eagleBlink,
  eagleSprite,
} from "./boot-art.mjs";

// --- colour helpers ---------------------------------------------------------

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const lerp = (a, b, t) => a + (b - a) * t;
const mix = (c1, c2, t) => [
  Math.round(lerp(c1[0], c2[0], t)),
  Math.round(lerp(c1[1], c2[1], t)),
  Math.round(lerp(c1[2], c2[2], t)),
];

function rgbTo256([r, g, b]) {
  if (Math.abs(r - g) < 8 && Math.abs(g - b) < 8) {
    if (r < 8) return 16;
    if (r > 248) return 231;
    return 232 + Math.round(((r - 8) / 247) * 23);
  }
  const q = (v) => Math.round((clamp(v, 0, 255) / 255) * 5);
  return 16 + 36 * q(r) + 6 * q(g) + q(b);
}

function fg(rgb, mode) {
  if (mode === "mono") return "";
  if (mode === "256") return `\x1b[38;5;${rgbTo256(rgb)}m`;
  return `\x1b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m`;
}
function bg(rgb, mode) {
  if (mode === "mono") return "";
  if (mode === "256") return `\x1b[48;5;${rgbTo256(rgb)}m`;
  return `\x1b[48;2;${rgb[0]};${rgb[1]};${rgb[2]}m`;
}
const reset = (mode) => (mode === "mono" ? "" : "\x1b[0m");

// --- capability detection ---------------------------------------------------

export function detectCaps({ env = process.env, isTTY, columns, fast, motion } = {}) {
  const tty = isTTY ?? Boolean(process.stdout.isTTY);
  const cols = columns ?? (Number(env.COLUMNS) || process.stdout.columns || 80);
  const noColor = "NO_COLOR" in env;
  const motionPref = motion ?? env.BENCH_BOOT_MOTION ?? "auto";
  const truecolor = /truecolor|24bit/i.test(env.COLORTERM || "");
  const has256 = truecolor || /256|xterm|screen|tmux|vt100/.test(env.TERM || "");

  let mode = "mono";
  if (tty && !noColor) mode = truecolor ? "truecolor" : has256 ? "256" : "mono";

  // Motion only when we have a colour TTY and the user/CI hasn't opted out.
  const animate =
    tty && mode !== "mono" && !fast && motionPref !== "off" && !env.CI;

  return { mode, animate, columns: cols, tty };
}

// --- wordmark grid ----------------------------------------------------------

let wordmarkCache = null;
function wordmarkGrid() {
  if (wordmarkCache) return wordmarkCache;
  const rows = Array.from({ length: GLYPH_ROWS }, () => "");
  let width = 0;
  const chars = WORDMARK.split("");
  chars.forEach((ch, idx) => {
    const glyph = GLYPHS[ch] ?? GLYPHS[" "];
    const gw = glyph[0].length;
    for (let r = 0; r < GLYPH_ROWS; r += 1) rows[r] += glyph[r];
    width += gw;
    if (idx < chars.length - 1) {
      for (let r = 0; r < GLYPH_ROWS; r += 1) rows[r] += " "; // 1-col kerning
      width += 1;
    }
  });
  wordmarkCache = { rows, width };
  return wordmarkCache;
}

// Infrared gradient sampled left->right (0..1) across the wordmark.
function gradientAt(t) {
  const [s0, s1, s2] = IR_GRADIENT;
  return t < 0.5 ? mix(s0, s1, t / 0.5) : mix(s1, s2, (t - 0.5) / 0.5);
}

// --- frame assembly (shared by static + animated paths) ---------------------

const SHIMMER_BAND = 7; // columns of half-width for the chalk shimmer crest

function eagleLines({ mode, bright = 1, sprite = eagleSprite(), pad = "" }) {
  const lines = [];
  for (let t = 0; t < sprite.length; t += 2) {
    const top = sprite[t];
    const bot = sprite[t + 1] ?? ".".repeat(top.length);
    let line = pad;
    for (let c = 0; c < top.length; c += 1) {
      const tc = EAGLE_PALETTE[top[c]];
      const bc = EAGLE_PALETTE[bot[c]];
      const shade = (rgb) => (bright >= 1 ? rgb : mix(BRAND.ink0, rgb, bright));
      if (tc && bc) line += `${fg(shade(tc), mode)}${bg(shade(bc), mode)}▀${reset(mode)}`;
      else if (tc) line += `${fg(shade(tc), mode)}▀${reset(mode)}`;
      else if (bc) line += `${fg(shade(bc), mode)}▄${reset(mode)}`;
      else line += " ";
    }
    lines.push(line);
  }
  return lines;
}

function wordmarkLines({ mode, reveal = Infinity, band = null, pad = "" }) {
  const { rows, width } = wordmarkGrid();
  return rows.map((row) => {
    let line = pad;
    for (let x = 0; x < row.length; x += 1) {
      if (row[x] !== "#" || x > reveal) {
        line += " ";
        continue;
      }
      let color = gradientAt(width > 1 ? x / (width - 1) : 0);
      if (band !== null) {
        const d = Math.abs(x - band) / SHIMMER_BAND;
        if (d < 1) color = mix(color, BRAND.chalk, (1 - d) * 0.6);
      }
      line += `${fg(color, mode)}█${reset(mode)}`;
    }
    return line;
  });
}

function taglineLine({ mode, chars = TAGLINE.length, pad = "" }) {
  const text = TAGLINE.slice(0, Math.max(0, chars));
  return `${pad}${fg(BRAND.chalkDim, mode)}${text}${reset(mode)}`;
}

// Centre a block of given width inside the terminal.
function padFor(width, columns) {
  return " ".repeat(Math.max(0, Math.floor((columns - width) / 2)));
}

function assemble({
  mode,
  columns,
  eagleBright = 1,
  sprite = eagleSprite(),
  reveal = Infinity,
  band = null,
  taglineChars = TAGLINE.length,
}) {
  const { width: wmWidth } = wordmarkGrid();
  const eagleW = sprite[0].length;
  const canvasW = Math.max(eagleW, wmWidth, TAGLINE.length);
  const canvasPad = padFor(canvasW, columns); // centre the whole canvas once
  const within = (w) => " ".repeat(Math.max(0, Math.floor((canvasW - w) / 2)));
  const ePad = canvasPad + within(eagleW);
  const wPad = canvasPad + within(wmWidth);
  const tPad = canvasPad + within(TAGLINE.length);

  return [
    "",
    ...eagleLines({ mode, bright: eagleBright, sprite, pad: ePad }),
    "",
    ...wordmarkLines({ mode, reveal, band, pad: wPad }),
    "",
    taglineLine({ mode, chars: taglineChars, pad: tPad }),
    "",
  ];
}

// Narrow terminals: a single-line wordmark instead of the 5-row block font.
function compactFrame({ mode, columns }) {
  const pad = padFor(WORDMARK.length, columns);
  const color = mode === "mono" ? "" : fg(BRAND.ir200, mode);
  return [`${pad}${color}${WORDMARK}${reset(mode)}`, `${padFor(TAGLINE.length, columns)}${taglineLine({ mode, pad: "" })}`];
}

export function renderStaticFrame({ mode = "mono", columns = 80 } = {}) {
  if (columns < 44) return compactFrame({ mode, columns }).join("\n");
  return assemble({ mode, columns }).join("\n");
}

// --- animation --------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function paint(lines) {
  process.stdout.write("\x1b[H" + lines.map((l) => l + "\x1b[K").join("\n"));
}

export async function runBoot(opts = {}) {
  const caps = detectCaps(opts);
  const { mode, animate, columns } = caps;

  // Paths 1 & 2: static frame (mono has zero escape bytes).
  if (!animate) {
    const frame = renderStaticFrame({ mode, columns });
    if (opts.write !== false) process.stdout.write(frame + "\n");
    return frame;
  }

  // Narrow colour terminals still animate poorly; show the compact frame.
  if (columns < 44) {
    const frame = compactFrame({ mode, columns }).join("\n");
    process.stdout.write(frame + "\n");
    return frame;
  }

  const { width: wmWidth } = wordmarkGrid();
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    process.stdout.write("\x1b[?25h" + reset(mode) + "\n");
  };
  const onSignal = () => {
    cleanup();
    process.exit(130);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  try {
    process.stdout.write("\x1b[?25l\x1b[2J\x1b[H"); // hide cursor, clear

    // Stage A — eagle fades in (brightness ramp), wordmark + tagline hidden.
    for (let i = 0; i < 5; i += 1) {
      const bright = 0.25 + (i / 4) * 0.75;
      paint(assemble({ mode, columns, eagleBright: bright, reveal: -1, taglineChars: 0 }));
      await sleep(55);
    }

    // Stage B — wordmark wipes in left->right while the shimmer crest sweeps.
    const N = 16;
    for (let i = 0; i < N; i += 1) {
      const p = i / (N - 1);
      const reveal = p * (wmWidth + 4);
      const band = p * (wmWidth + SHIMMER_BAND) - SHIMMER_BAND;
      paint(assemble({ mode, columns, reveal, band, taglineChars: 0 }));
      await sleep(45);
    }

    // Stage C — shimmer exits, tagline types in.
    for (let i = 0; i < TAGLINE.length; i += 1) {
      const band = wmWidth + SHIMMER_BAND + i; // off the right edge, fades out
      paint(assemble({ mode, columns, band: band < wmWidth + SHIMMER_BAND * 2 ? band : null, taglineChars: i + 1 }));
      await sleep(14);
    }

    // Stage D — one slow blink, then settle on the full frame.
    paint(assemble({ mode, columns, sprite: eagleBlink() }));
    await sleep(120);
    paint(assemble({ mode, columns }));
    await sleep(60);
  } finally {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    cleanup();
  }
  return assemble({ mode, columns }).join("\n");
}

// --- CLI --------------------------------------------------------------------

function isMain() {
  return process.argv[1] && process.argv[1].endsWith("boot.mjs");
}

if (isMain()) {
  const args = process.argv.slice(2);
  const fast = args.includes("--fast");
  const motion = args.includes("--no-motion") ? "off" : undefined;
  runBoot({ fast, motion }).catch((error) => {
    process.stdout.write("\x1b[?25h\x1b[0m");
    process.stderr.write(`boot: ${error?.stack ?? error}\n`);
    process.exitCode = 1;
  });
}
