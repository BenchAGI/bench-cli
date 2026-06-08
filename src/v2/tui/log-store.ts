// log-store.ts — the ink TUI's output buffer. The StreamRenderer (via the ansi log sink) writes raw
// chunks that may contain partial lines and embedded ANSI. This turns that stream into committed
// lines (rendered once by ink <Static>, flowing into native scrollback) plus a live "pending" line
// (the in-progress assistant/thinking region that commits when a newline arrives).
//
// IMPORTANT — ink <Static> contract (caught in adversarial review): Static memoizes the tail it
// renders on the items array REFERENCE + an internal absolute index, and assumes the list is
// APPEND-ONLY. So we must (1) hand React a NEW array identity on every append (immutable concat),
// and (2) never shrink the array from the front. When we genuinely must reset (clear, or a safety
// cap trim), we bump `generation`; the app keys <Static> on it so ink remounts with a fresh index.

export type LogState = { lines: string[]; pending: string; generation: number };

// Append-only by design; the cap is a high safety backstop, not a normal-operation limit (the
// terminal's own scrollback holds history). Crossing it triggers a one-time generation remount.
const DEFAULT_CAP = 50_000;
// Bound the live pending region: a pathologically long line with no newline would otherwise
// re-render O(n) on every sink write. Flush it to a committed chunk past this size.
const PENDING_FLUSH = 8_192;

export class LogStore {
  private lines: string[] = [];
  private pending = "";
  private version = 0;
  private generation = 0;
  private listeners = new Set<() => void>();

  constructor(private cap = DEFAULT_CAP) {}

  // The sink. Normalizes carriage returns, splits on newlines: complete lines commit (immutably),
  // the trailing partial segment stays pending.
  write = (chunk: string): void => {
    if (!chunk) return;
    const normalized = chunk.replace(/\r\n/g, "\n").replace(/\r/g, "");
    const text = this.pending + normalized;
    const parts = text.split("\n");
    this.pending = parts.pop() ?? "";
    const toCommit = parts;
    if (this.pending.length > PENDING_FLUSH) {
      toCommit.push(this.pending);
      this.pending = "";
    }
    if (toCommit.length > 0) {
      this.lines = this.lines.concat(toCommit); // new identity → <Static> renders the new tail
      if (this.lines.length > this.cap) {
        this.lines = this.lines.slice(-this.cap); // never front-trim in place; remount instead
        this.generation += 1;
      }
    }
    this.bump();
  };

  // Push a discrete line directly (used by local slash output that's already line-shaped).
  pushLine = (line: string): void => {
    this.write(line.endsWith("\n") ? line : line + "\n");
  };

  // Clear the screen buffer (/clear). Bumps generation so <Static> remounts empty. Does NOT touch
  // the server session.
  clear = (): void => {
    this.lines = [];
    this.pending = "";
    this.generation += 1;
    this.bump();
  };

  snapshot = (): LogState => ({ lines: this.lines, pending: this.pending, generation: this.generation });

  // useSyncExternalStore plumbing — getVersion is the stable snapshot value.
  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };
  getVersion = (): number => this.version;

  private bump(): void {
    this.version += 1;
    for (const fn of this.listeners) fn();
  }
}
