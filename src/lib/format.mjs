// Tiny formatting helpers. No third-party deps so the CLI stays inspectable.

const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  magenta: "\x1b[35m",
};

const useColor =
  process.stdout.isTTY && !process.env.NO_COLOR && process.env.TERM !== "dumb";

export function color(name, s) {
  if (!useColor) return s;
  return (ANSI[name] ?? "") + s + ANSI.reset;
}

export const c = {
  bold: (s) => color("bold", s),
  dim: (s) => color("dim", s),
  red: (s) => color("red", s),
  green: (s) => color("green", s),
  yellow: (s) => color("yellow", s),
  cyan: (s) => color("cyan", s),
  magenta: (s) => color("magenta", s),
};

/**
 * Render a simple aligned table from rows of equal length. Header is a string[].
 *
 * @param {string[]} header
 * @param {(string|number|null|undefined)[][]} rows
 */
export function table(header, rows) {
  const cells = [header, ...rows.map((r) => r.map((v) => stringify(v)))];
  const widths = header.map((_, col) =>
    Math.max(...cells.map((row) => visibleWidth(row[col] ?? ""))),
  );
  const fmtRow = (row) =>
    row
      .map((v, i) => padRight(stringify(v), widths[i]))
      .join("  ")
      .trimEnd();
  const head = c.bold(fmtRow(header));
  const sep = c.dim(widths.map((w) => "-".repeat(w)).join("  "));
  const body = rows.map((r) => fmtRow(r)).join("\n");
  return [head, sep, body].filter(Boolean).join("\n");
}

function stringify(v) {
  if (v === null || v === undefined) return "";
  return String(v);
}

function padRight(s, w) {
  const pad = w - visibleWidth(s);
  return pad > 0 ? s + " ".repeat(pad) : s;
}

function visibleWidth(s) {
  // Strip ANSI for width math.
  return String(s).replace(/\x1b\[[0-9;]*m/g, "").length;
}

/**
 * Format a UNIX-ish timestamp (ms or ISO string) as a short relative age.
 *
 * @param {number|string|null|undefined} ts
 */
export function relativeAge(ts) {
  if (ts === null || ts === undefined) return "";
  const ms = typeof ts === "string" ? Date.parse(ts) : Number(ts);
  if (!Number.isFinite(ms)) return "";
  const diff = Date.now() - ms;
  if (diff < 0) return "in the future";
  const sec = Math.round(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 48) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  return `${day}d ago`;
}

/**
 * Truncate a string to N visible chars, adding an ellipsis if truncated.
 */
export function truncate(s, n) {
  if (!s) return "";
  return s.length > n ? s.slice(0, Math.max(0, n - 1)) + "…" : s;
}
