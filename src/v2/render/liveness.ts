// Two-clock liveness indicator — SPEC §7 (post-ANVIL P1 fix).
// Tracks runQuietMs (since last non-tick run event) and gatewayTickMs
// (since last tick) independently. TTY: animated single-line. Non-TTY:
// status line every 30s.

import { c, cursor, isTTY, writeRaw } from "./ansi.js";

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export type LivenessConfig = {
  agentId: string;
  pid: number;
  livenessThresholdMs: number;
  unhealthyTickThresholdMs: number;
  stuckRunThresholdMs: number;
  // For testing: override Date.now() and override stdout.
  now?: () => number;
  writeLine?: (line: string) => void;
};

export class LivenessIndicator {
  private lastEvent = Date.now();
  private lastTick = Date.now();
  private lifecycleStarted: number | null = null;
  private timer: NodeJS.Timeout | null = null;
  private nonTtyTimer: NodeJS.Timeout | null = null;
  private spinnerIdx = 0;
  private visible = false;
  // V1.1 — Item 2: indicator is visible only while a run is in flight.
  // chat-runner toggles this via setInFlight() at run start/end.
  private inFlight = false;
  // V1.1 — Item 2: truthful reconnect label, fed by transport's
  // onReconnecting/onReconnected callbacks.
  private reconnectAttempt: number | null = null;
  private reconnectDelayMs: number | null = null;
  private now: () => number;
  private writeLine: (line: string) => void;

  constructor(private cfg: LivenessConfig) {
    this.now = cfg.now ?? (() => Date.now());
    this.writeLine = cfg.writeLine ?? defaultWriteLine;
  }

  recordEvent(now: number, isTick: boolean): void {
    if (isTick) {
      this.lastTick = now;
      return;
    }
    this.lastEvent = now;
    if (this.visible) this.hide();
  }

  recordLifecycleStart(): void {
    this.lifecycleStarted = this.now();
    this.lastEvent = this.now();
    this.inFlight = true;
  }

  /**
   * Toggle whether a run is currently in flight. Indicator is hidden
   * (and tick is a no-op) while no run is active.
   *
   * Edge case (Codex Anvil P2): if a reconnect is in flight when the
   * run completes, the indicator must STAY visible — the user is
   * still waiting for the transport to recover. Only hide when no
   * reconnect is pending. V1.1 — Item 2.
   */
  setInFlight(value: boolean): void {
    this.inFlight = value;
    if (!value && this.visible && this.reconnectAttempt === null) this.hide();
  }

  /**
   * Mark a reconnect attempt as in flight so the indicator label
   * reflects the actual transport state (V1.1 — Item 2). The
   * indicator becomes visible during reconnect even when a run is
   * not in flight, so the user knows the CLI is intentionally
   * waiting rather than hung.
   */
  setReconnecting(attempt: number, delayMs: number): void {
    this.reconnectAttempt = attempt;
    this.reconnectDelayMs = delayMs;
    // Force-render even outside an in-flight run so the reconnect
    // label is visible during background reconnects.
    if (isTTY && !this.visible) this.show();
  }

  /**
   * Clear the reconnect label (call on transport.onReconnected).
   * V1.1 — Item 2.
   */
  clearReconnecting(): void {
    this.reconnectAttempt = null;
    this.reconnectDelayMs = null;
    if (this.visible && !this.inFlight) this.hide();
  }

  start(): void {
    if (isTTY) {
      this.timer = setInterval(() => this.tick(), 1000);
    } else {
      this.nonTtyTimer = setInterval(() => this.printNonTty(), 30_000);
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.nonTtyTimer) clearInterval(this.nonTtyTimer);
    this.timer = null;
    this.nonTtyTimer = null;
    if (this.visible) this.hide();
  }

  status(): string {
    const now = this.now();
    const runQuiet = Math.max(0, now - this.lastEvent);
    const gatewayTick = Math.max(0, now - this.lastTick);
    return formatStatus({
      agentId: this.cfg.agentId,
      pid: this.cfg.pid,
      runQuietMs: runQuiet,
      gatewayTickMs: gatewayTick,
      stuck: runQuiet > this.cfg.stuckRunThresholdMs && gatewayTick < 5_000,
      unhealthyTick: gatewayTick > this.cfg.unhealthyTickThresholdMs,
      spinnerFrame: SPINNER[this.spinnerIdx % SPINNER.length] as string,
      reconnectAttempt: this.reconnectAttempt,
      reconnectDelayMs: this.reconnectDelayMs,
    });
  }

  private tick(): void {
    // V1.1 — Item 2: skip the tick when no run is in flight AND we
    // are not actively reconnecting. The indicator should be silent
    // between REPL turns so it doesn't compete with the prompt.
    if (!this.inFlight && this.reconnectAttempt === null) {
      if (this.visible) this.hide();
      return;
    }
    const now = this.now();
    const runQuiet = now - this.lastEvent;
    // During reconnect, render regardless of run-quiet threshold so
    // the user sees the reconnect-attempt label promptly.
    const showForReconnect = this.reconnectAttempt !== null;
    if (!showForReconnect && runQuiet < this.cfg.livenessThresholdMs) {
      if (this.visible) this.hide();
      return;
    }
    this.spinnerIdx = (this.spinnerIdx + 1) % SPINNER.length;
    if (!this.visible) {
      this.show();
    } else {
      this.repaint();
    }
  }

  private printNonTty(): void {
    // V1.1 — Item 2: stay silent when no run is in flight (nothing to
    // monitor) unless a reconnect is in flight.
    if (!this.inFlight && this.reconnectAttempt === null) return;
    const now = this.now();
    const runQuiet = now - this.lastEvent;
    if (this.reconnectAttempt === null && runQuiet < this.cfg.livenessThresholdMs) return;
    const gatewayTick = now - this.lastTick;
    const reconnectSuffix =
      this.reconnectAttempt !== null
        ? ` reconnecting=attempt-${this.reconnectAttempt}`
        : "";
    this.writeLine(
      `[benchagi liveness] runQuiet=${Math.round(runQuiet / 1000)}s ` +
      `gatewayTick=${Math.round(gatewayTick / 1000)}s pid=${this.cfg.pid}` +
      reconnectSuffix,
    );
  }

  private show(): void {
    this.visible = true;
    cursor.hide();
    this.repaint();
  }

  private repaint(): void {
    cursor.clearLine();
    process.stdout.write(this.status());
  }

  private hide(): void {
    this.visible = false;
    cursor.clearLine();
    cursor.show();
  }
}

type FormatArgs = {
  agentId: string;
  pid: number;
  runQuietMs: number;
  gatewayTickMs: number;
  stuck: boolean;
  unhealthyTick: boolean;
  spinnerFrame: string;
  // V1.1 — Item 2: when reconnect is in flight, the label should
  // reflect the actual transport state (which the chat-runner feeds
  // in via setReconnecting) rather than guessing from tick staleness.
  reconnectAttempt?: number | null;
  reconnectDelayMs?: number | null;
};

export function formatStatus(args: FormatArgs): string {
  const runQuietS = Math.round(args.runQuietMs / 1000);
  const gatewayTickS = Math.round(args.gatewayTickMs / 1000);
  const base =
    `${args.spinnerFrame} ${args.agentId} · ` +
    `run quiet ${runQuietS}s · gateway tick ${gatewayTickS}s · ` +
    `pid ${args.pid} · Ctrl-C abort`;
  // Truthful reconnect label takes precedence over the
  // unhealthyTick heuristic when transport reports an active reconnect.
  if (typeof args.reconnectAttempt === "number") {
    const delayS =
      typeof args.reconnectDelayMs === "number"
        ? Math.round(args.reconnectDelayMs / 1000)
        : null;
    const suffix =
      delayS !== null
        ? `(reconnecting attempt ${args.reconnectAttempt} in ${delayS}s)`
        : `(reconnecting attempt ${args.reconnectAttempt})`;
    return c.yellow(`${base} ${suffix}`);
  }
  if (args.unhealthyTick) {
    return c.yellow(base + " (connection unhealthy)");
  }
  if (args.stuck) {
    return c.red(base + " (may be stuck — Ctrl-C abort)");
  }
  return c.dim(base);
}

function defaultWriteLine(line: string): void {
  writeRaw(line + "\n");
}
