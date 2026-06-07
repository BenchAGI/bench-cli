// log-store.ts — the ink TUI's output buffer. The StreamRenderer (via the ansi log sink) writes raw
// chunks that may contain partial lines and embedded ANSI. This turns that stream into committed
// lines (rendered once by ink <Static>, flowing into native scrollback) plus a live "pending" line
// (the in-progress assistant/thinking region that commits when a newline arrives).

export type LogState = { lines: string[]; pending: string };

const DEFAULT_CAP = 5000;

export class LogStore {
  private lines: string[] = [];
  private pending = "";
  private version = 0;
  private listeners = new Set<() => void>();

  constructor(private cap = DEFAULT_CAP) {}

  // The sink. Normalizes carriage returns, splits on newlines: complete lines commit, the trailing
  // partial segment stays pending.
  write = (chunk: string): void => {
    if (!chunk) return;
    const normalized = chunk.replace(/\r\n/g, "\n").replace(/\r/g, "");
    const text = this.pending + normalized;
    const parts = text.split("\n");
    this.pending = parts.pop() ?? "";
    if (parts.length > 0) {
      this.lines.push(...parts);
      if (this.lines.length > this.cap) this.lines.splice(0, this.lines.length - this.cap);
    }
    this.bump();
  };

  // Push a discrete line directly (used by local slash output that's already line-shaped).
  pushLine = (line: string): void => {
    this.write(line.endsWith("\n") ? line : line + "\n");
  };

  // Clear the screen buffer (/clear) — does NOT touch the server session.
  clear = (): void => {
    this.lines = [];
    this.pending = "";
    this.bump();
  };

  snapshot = (): LogState => ({ lines: this.lines, pending: this.pending });

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
