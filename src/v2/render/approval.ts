// Approval state machine — SPEC §6.5 (post-ANVIL P1 fix).
// PENDING → resolved by user [A]/[D]/Ctrl-C, or by peer (resolved event).

import type { ApprovalEventData } from "../protocol/types.js";
import { c, println } from "./ansi.js";

export type ApprovalDecision = "approve" | "deny";

export type ApprovalAction = {
  kind: "exec" | "plugin";
  approvalId: string;
  decision: ApprovalDecision;
};

type Pending = {
  approvalId: string;
  approvalSlug?: string;
  kind: "exec" | "plugin" | "unknown";
  title: string;
  command?: string;
  reason?: string;
};

export class ApprovalState {
  private pending: Pending | null = null;

  constructor(
    private resolveCb: (action: ApprovalAction) => Promise<void>,
  ) {}

  isPending(): boolean {
    return this.pending !== null;
  }

  pendingApprovalId(): string | null {
    return this.pending?.approvalId ?? null;
  }

  // Called when an `approval` stream event arrives.
  onAgentApproval(data: ApprovalEventData | null | undefined): void {
    if (!data) return;
    if (data.phase === "requested" && data.approvalId) {
      this.pending = {
        approvalId: data.approvalId,
        approvalSlug: data.approvalSlug,
        kind: data.kind,
        title: data.title,
        command: data.command,
        reason: data.reason,
      };
      this.render();
      return;
    }
    if (data.phase === "resolved" && data.approvalId) {
      if (this.pending?.approvalId === data.approvalId) {
        this.pending = null;
      }
      println(c.dim(`  → approval ${data.status}`));
    }
  }

  // Called when a top-level exec.approval.resolved/plugin.approval.resolved
  // event arrives.
  onTopLevelResolved(payload: unknown): void {
    if (!payload || typeof payload !== "object") return;
    const id = (payload as { approvalId?: string; id?: string }).approvalId
      ?? (payload as { approvalId?: string; id?: string }).id;
    if (id && this.pending?.approvalId === id) {
      this.pending = null;
    }
  }

  /**
   * Synchronous predicate — would `handleKey(key)` consume this
   * keystroke right now? Lets the REPL decide whether to clear the
   * readline line buffer SYNCHRONOUSLY, before any await yields to
   * the event loop. Without a sync gate, a fast `a` + Enter could
   * race the async resolve and emit a stray chat message. V1.1 —
   * Item 3 (Codex Anvil P1).
   */
  canConsumeKey(key: string): boolean {
    if (!this.pending) return false;
    const lower = key.toLowerCase();
    return lower === "a" || lower === "d";
  }

  // Returns true if the keystroke was consumed by approval handling.
  async handleKey(key: string): Promise<boolean> {
    if (!this.pending) return false;
    const lower = key.toLowerCase();
    if (lower === "a") {
      await this.resolve("approve");
      return true;
    }
    if (lower === "d") {
      await this.resolve("deny");
      return true;
    }
    return false;
  }

  // Default-deny on Ctrl-C.
  async denyOnInterrupt(): Promise<void> {
    if (!this.pending) return;
    await this.resolve("deny");
  }

  private async resolve(decision: ApprovalDecision): Promise<void> {
    if (!this.pending) return;
    const kind = this.pending.kind === "unknown" ? "exec" : this.pending.kind;
    const action: ApprovalAction = {
      kind,
      approvalId: this.pending.approvalId,
      decision,
    };
    this.pending = null;
    println(c.dim(`  → you ${decision}`));
    await this.resolveCb(action);
  }

  private render(): void {
    if (!this.pending) return;
    const lines = [
      "",
      c.yellow(`▶ approval requested: ${this.pending.title}`),
      this.pending.command ? c.dim(`  command: ${this.pending.command}`) : "",
      this.pending.reason ? c.dim(`  reason: ${this.pending.reason}`) : "",
      c.bold(`  [A]pprove · [D]eny · Ctrl-C = deny`),
      "",
    ].filter((s) => s.length > 0);
    for (const line of lines) println(line);
  }
}
