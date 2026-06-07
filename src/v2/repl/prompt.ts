// REPL prompt — SPEC §3 / §13.
// node:readline-based, multi-line continuation (\), arrow history.

import { createInterface, type Interface } from "node:readline";
import { c, println } from "../render/ansi.js";

export type ReplOptions = {
  prompt?: string;
  promptContinuation?: string;
  /**
   * Optional status line rendered above the prompt on each turn (e.g. the
   * BenchAGI seat identity + a 🔔 when the agent needs the operator). Called
   * synchronously at prompt time; return "" to render nothing.
   */
  statusLine?: () => string;
};

export type ReplCallbacks = {
  onMessage(message: string): Promise<void>;
  onInterrupt(): Promise<void>;
  onExit(): Promise<void>;
  onKey?(key: string): Promise<boolean>;
  /**
   * Optional sync predicate that mirrors `onKey`'s consume-or-not
   * decision without firing the side-effect resolve. The REPL uses
   * it to clear its line buffer synchronously, before the async
   * `onKey` yields to the event loop, avoiding a `[A]` + Enter race.
   * V1.1 — Item 3 (Codex Anvil P1).
   */
  canConsumeKey?(key: string): boolean;
};

export class Repl {
  private rl: Interface;
  private history: string[] = [];
  private buffer: string[] = [];
  private prompt: string;
  private promptContinuation: string;
  private statusLine?: () => string;
  private busy = false;

  constructor(opts: ReplOptions, private cb: ReplCallbacks) {
    this.prompt = opts.prompt ?? c.cyan("> ");
    this.promptContinuation = opts.promptContinuation ?? c.dim("… ");
    this.statusLine = opts.statusLine;
    this.rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      historySize: 200,
      removeHistoryDuplicates: true,
      terminal: process.stdin.isTTY === true,
    });
  }

  async start(): Promise<void> {
    this.rl.on("line", (line) => {
      void this.handleLine(line);
    });

    this.rl.on("SIGINT", async () => {
      if (this.busy) {
        await this.cb.onInterrupt();
      } else if (this.buffer.length > 0) {
        this.buffer = [];
        println(c.dim("(input cleared)"));
        this.showPrompt();
      } else {
        println(c.dim("(press Ctrl-D to exit)"));
        this.showPrompt();
      }
    });

    this.rl.on("close", async () => {
      await this.cb.onExit();
    });

    if (process.stdin.isTTY === true) {
      // Single-key handling for [A]/[D] approval shortcuts and [r] expand.
      // Readline puts stdin in raw mode when `terminal: true`, so keypress
      // events fire per-keystroke. V1.1 — Item 3.
      const stdin = process.stdin;
      stdin.on("keypress", (str: string, key: { name?: string; ctrl?: boolean; sequence?: string } | undefined) => {
        if (!this.busy || !key?.sequence) return;
        // Sync predicate: would onKey consume this key? If yes, we
        // clear the line buffer SYNCHRONOUSLY (deferred to nextTick
        // so readline's own keypress listener processes the original
        // char first). The async resolve fires fire-and-forget. This
        // closes the race where a fast `a` + Enter could emit a stray
        // chat message before the async resolve completed (Codex
        // Anvil P1).
        if (this.cb.canConsumeKey?.(key.sequence) && this.cb.onKey) {
          void this.cb.onKey(key.sequence);
          process.nextTick(() => {
            this.rl.write(null, { ctrl: true, name: "u" });
          });
        }
      });
    }

    this.showPrompt();
  }

  private async handleLine(line: string): Promise<void> {
    if (line.endsWith("\\")) {
      this.buffer.push(line.slice(0, -1));
      this.rl.setPrompt(this.promptContinuation);
      this.rl.prompt();
      return;
    }
    this.buffer.push(line);
    const message = this.buffer.join("\n");
    this.buffer = [];

    if (message.length === 0) {
      this.showPrompt();
      return;
    }

    if (message === "/exit" || message === "/quit") {
      this.rl.close();
      return;
    }

    this.history.push(message);
    this.busy = true;
    try {
      await this.cb.onMessage(message);
    } finally {
      this.busy = false;
      this.showPrompt();
    }
  }

  private showPrompt(): void {
    if (this.statusLine) {
      try {
        const s = this.statusLine();
        if (s) println(s);
      } catch {
        // a status-line error must never break the REPL
      }
    }
    this.rl.setPrompt(this.prompt);
    this.rl.prompt();
  }

  close(): void {
    this.rl.close();
  }

  isBusy(): boolean {
    return this.busy;
  }
}
