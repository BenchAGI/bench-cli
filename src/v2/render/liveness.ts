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
    });
  }

  private tick(): void {
    const now = this.now();
    const runQuiet = now - this.lastEvent;
    if (runQuiet < this.cfg.livenessThresholdMs) {
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
    const now = this.now();
    const runQuiet = now - this.lastEvent;
    if (runQuiet < this.cfg.livenessThresholdMs) return;
    const gatewayTick = now - this.lastTick;
    this.writeLine(
      `[benchagi liveness] runQuiet=${Math.round(runQuiet / 1000)}s ` +
      `gatewayTick=${Math.round(gatewayTick / 1000)}s pid=${this.cfg.pid}`,
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
};

export function formatStatus(args: FormatArgs): string {
  const runQuietS = Math.round(args.runQuietMs / 1000);
  const gatewayTickS = Math.round(args.gatewayTickMs / 1000);
  const base =
    `${args.spinnerFrame} ${args.agentId} · ` +
    `run quiet ${runQuietS}s · gateway tick ${gatewayTickS}s · ` +
    `pid ${args.pid} · Ctrl-C abort`;
  if (args.unhealthyTick) {
    return c.yellow(base + " (connection unhealthy — reconnecting)");
  }
  if (args.stuck) {
    return c.red(base + " (may be stuck — Ctrl-C abort)");
  }
  return c.dim(base);
}

function defaultWriteLine(line: string): void {
  writeRaw(line + "\n");
}
