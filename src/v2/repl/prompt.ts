// REPL prompt — SPEC §3 / §13.
// node:readline-based, multi-line continuation (\), arrow history.

import { createInterface, type Interface } from "node:readline";
import { c, println } from "../render/ansi.js";

export type ReplOptions = {
  prompt?: string;
  promptContinuation?: string;
};

export type ReplCallbacks = {
  onMessage(message: string): Promise<void>;
  onInterrupt(): Promise<void>;
  onExit(): Promise<void>;
  onKey?(key: string): Promise<boolean>;
};

export class Repl {
  private rl: Interface;
  private history: string[] = [];
  private buffer: string[] = [];
  private prompt: string;
  private promptContinuation: string;
  private busy = false;

  constructor(opts: ReplOptions, private cb: ReplCallbacks) {
    this.prompt = opts.prompt ?? c.cyan("> ");
    this.promptContinuation = opts.promptContinuation ?? c.dim("… ");
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
      stdin.on("keypress", async (str: string, key: { name?: string; ctrl?: boolean; sequence?: string } | undefined) => {
        if (this.busy && this.cb.onKey && key?.sequence) {
          const consumed = await this.cb.onKey(key.sequence);
          if (consumed) {
            // Strip the consumed character from readline's line buffer
            // so that pressing Enter later doesn't re-send the
            // approval key as a chat message. Ctrl-U kills the line.
            this.rl.write(null, { ctrl: true, name: "u" });
            return;
          }
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
