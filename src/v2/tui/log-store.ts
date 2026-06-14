// log-store.ts — the ink TUI's output buffer. The StreamRenderer (via the ansi log sink) writes raw
// chunks that may contain partial lines and embedded ANSI. This turns that stream into committed
// lines plus a live "pending" line (the in-progress assistant/thinking region that commits when a
// newline arrives). The App renders a bounded viewport over this buffer; terminal scrollback is not
// the source of truth for TUI history.
//
// IMPORTANT: hand React a NEW array identity on every append (immutable concat). When we reset
// history (/clear or safety cap trim), `generation` advances so subscribers can tell it was a reset.

export type LogState = { lines: string[]; pending: string; generation: number };

// Append-only by design; the cap is a high safety backstop, not a normal-operation limit. Crossing
// it trims to the most-recent HALF and bumps generation. The half-trim adds hysteresis so trimming
// happens only ~once per cap/2 lines, not on every commit once full (amortized O(1) per line).
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
      this.lines = this.lines.concat(toCommit); // new identity → React/ink renders the new tail
      if (this.lines.length > this.cap) {
        // Keep the recent half. Trimming to HALF (not exactly cap) is the hysteresis that keeps
        // trims rare; without it, a full buffer would trim on every single subsequent line.
        this.lines = this.lines.slice(-Math.max(1, Math.floor(this.cap / 2))); // max(1,…): slice(-0) would keep all
        this.generation += 1;
      }
    }
    this.bump();
  };

  // Push a discrete line directly (used by local slash output that's already line-shaped).
  pushLine = (line: string): void => {
    this.write(line.endsWith("\n") ? line : line + "\n");
  };

  // Clear the screen buffer (/clear). Does NOT touch the server session.
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
