// Two-clock liveness indicator — SPEC §7 (post-ANVIL P1 fix).
// Tracks runQuietMs (since last non-tick run event) and gatewayTickMs
// (since last tick) independently. TTY: animated single-line. Non-TTY:
// status line every 30s.
import { c, cursor, isTTY, writeRaw } from "./ansi.js";
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
export class LivenessIndicator {
    cfg;
    lastEvent = Date.now();
    lastTick = Date.now();
    lifecycleStarted = null;
    timer = null;
    nonTtyTimer = null;
    spinnerIdx = 0;
    visible = false;
    // V1.1 — Item 2: indicator is visible only while a run is in flight.
    // chat-runner toggles this via setInFlight() at run start/end.
    inFlight = false;
    // V1.1 — Item 2: truthful reconnect label, fed by transport's
    // onReconnecting/onReconnected callbacks.
    reconnectAttempt = null;
    reconnectDelayMs = null;
    now;
    writeLine;
    managed;
    constructor(cfg) {
        this.cfg = cfg;
        this.now = cfg.now ?? (() => Date.now());
        this.writeLine = cfg.writeLine ?? defaultWriteLine;
        this.managed = cfg.managed ?? false;
    }
    // Structured health for the TUI status bar — computed on demand from the clocks (no timer needed).
    snapshot() {
        const now = this.now();
        const runQuiet = Math.max(0, now - this.lastEvent);
        const gatewayTick = Math.max(0, now - this.lastTick);
        const stuck = runQuiet > this.cfg.stuckRunThresholdMs && gatewayTick < 5_000;
        const unhealthyTick = gatewayTick > this.cfg.unhealthyTickThresholdMs;
        let state = "ok";
        if (this.reconnectAttempt !== null)
            state = "reconnecting";
        else if (this.inFlight && stuck)
            state = "stuck";
        else if (unhealthyTick)
            state = "unhealthy";
        return {
            state,
            runQuietMs: runQuiet,
            gatewayTickMs: gatewayTick,
            inFlight: this.inFlight,
            reconnectAttempt: this.reconnectAttempt,
            reconnectDelayMs: this.reconnectDelayMs,
        };
    }
    recordEvent(now, isTick) {
        if (isTick) {
            this.lastTick = now;
            return;
        }
        this.lastEvent = now;
        if (this.visible)
            this.hide();
    }
    recordLifecycleStart() {
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
    setInFlight(value) {
        this.inFlight = value;
        if (!value && this.visible && this.reconnectAttempt === null)
            this.hide();
    }
    /**
     * Mark a reconnect attempt as in flight so the indicator label
     * reflects the actual transport state (V1.1 — Item 2). The
     * indicator becomes visible during reconnect even when a run is
     * not in flight, so the user knows the CLI is intentionally
     * waiting rather than hung.
     */
    setReconnecting(attempt, delayMs) {
        this.reconnectAttempt = attempt;
        this.reconnectDelayMs = delayMs;
        // Force-render even outside an in-flight run so the reconnect
        // label is visible during background reconnects.
        if (isTTY && !this.visible)
            this.show();
    }
    /**
     * Clear the reconnect label (call on transport.onReconnected).
     * V1.1 — Item 2.
     */
    clearReconnecting() {
        this.reconnectAttempt = null;
        this.reconnectDelayMs = null;
        if (this.visible && !this.inFlight)
            this.hide();
    }
    start() {
        if (this.managed)
            return; // TUI owns the screen; clocks still advance via record*/setReconnecting
        if (isTTY) {
            this.timer = setInterval(() => this.tick(), 1000);
        }
        else {
            this.nonTtyTimer = setInterval(() => this.printNonTty(), 30_000);
        }
    }
    stop() {
        if (this.timer)
            clearInterval(this.timer);
        if (this.nonTtyTimer)
            clearInterval(this.nonTtyTimer);
        this.timer = null;
        this.nonTtyTimer = null;
        if (this.visible)
            this.hide();
    }
    status() {
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
            spinnerFrame: SPINNER[this.spinnerIdx % SPINNER.length],
            reconnectAttempt: this.reconnectAttempt,
            reconnectDelayMs: this.reconnectDelayMs,
        });
    }
    tick() {
        // V1.1 — Item 2: skip the tick when no run is in flight AND we
        // are not actively reconnecting. The indicator should be silent
        // between REPL turns so it doesn't compete with the prompt.
        if (!this.inFlight && this.reconnectAttempt === null) {
            if (this.visible)
                this.hide();
            return;
        }
        const now = this.now();
        const runQuiet = now - this.lastEvent;
        // During reconnect, render regardless of run-quiet threshold so
        // the user sees the reconnect-attempt label promptly.
        const showForReconnect = this.reconnectAttempt !== null;
        if (!showForReconnect && runQuiet < this.cfg.livenessThresholdMs) {
            if (this.visible)
                this.hide();
            return;
        }
        this.spinnerIdx = (this.spinnerIdx + 1) % SPINNER.length;
        if (!this.visible) {
            this.show();
        }
        else {
            this.repaint();
        }
    }
    printNonTty() {
        // V1.1 — Item 2: stay silent when no run is in flight (nothing to
        // monitor) unless a reconnect is in flight.
        if (!this.inFlight && this.reconnectAttempt === null)
            return;
        const now = this.now();
        const runQuiet = now - this.lastEvent;
        if (this.reconnectAttempt === null && runQuiet < this.cfg.livenessThresholdMs)
            return;
        const gatewayTick = now - this.lastTick;
        const reconnectSuffix = this.reconnectAttempt !== null
            ? ` reconnecting=attempt-${this.reconnectAttempt}`
            : "";
        this.writeLine(`[benchagi liveness] runQuiet=${Math.round(runQuiet / 1000)}s ` +
            `gatewayTick=${Math.round(gatewayTick / 1000)}s pid=${this.cfg.pid}` +
            reconnectSuffix);
    }
    show() {
        if (this.managed)
            return; // never paint in managed mode
        this.visible = true;
        cursor.hide();
        this.repaint();
    }
    repaint() {
        cursor.clearLine();
        process.stdout.write(this.status());
    }
    hide() {
        this.visible = false;
        cursor.clearLine();
        cursor.show();
    }
}
export function formatStatus(args) {
    const runQuietS = Math.round(args.runQuietMs / 1000);
    const gatewayTickS = Math.round(args.gatewayTickMs / 1000);
    const base = `${args.spinnerFrame} ${args.agentId} · ` +
        `run quiet ${runQuietS}s · gateway tick ${gatewayTickS}s · ` +
        `pid ${args.pid} · Ctrl-C abort`;
    // Truthful reconnect label takes precedence over the
    // unhealthyTick heuristic when transport reports an active reconnect.
    if (typeof args.reconnectAttempt === "number") {
        const delayS = typeof args.reconnectDelayMs === "number"
            ? Math.round(args.reconnectDelayMs / 1000)
            : null;
        const suffix = delayS !== null
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
function defaultWriteLine(line) {
    writeRaw(line + "\n");
}
