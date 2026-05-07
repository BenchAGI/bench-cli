// REPL prompt — SPEC §3 / §13.
// node:readline-based, multi-line continuation (\), arrow history.
import { createInterface } from "node:readline";
import { c, println } from "../render/ansi.js";
export class Repl {
    cb;
    rl;
    history = [];
    buffer = [];
    prompt;
    promptContinuation;
    busy = false;
    constructor(opts, cb) {
        this.cb = cb;
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
    async start() {
        this.rl.on("line", (line) => {
            void this.handleLine(line);
        });
        this.rl.on("SIGINT", async () => {
            if (this.busy) {
                await this.cb.onInterrupt();
            }
            else if (this.buffer.length > 0) {
                this.buffer = [];
                println(c.dim("(input cleared)"));
                this.showPrompt();
            }
            else {
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
            stdin.on("keypress", (str, key) => {
                if (!this.busy || !key?.sequence)
                    return;
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
    async handleLine(line) {
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
        }
        finally {
            this.busy = false;
            this.showPrompt();
        }
    }
    showPrompt() {
        this.rl.setPrompt(this.prompt);
        this.rl.prompt();
    }
    close() {
        this.rl.close();
    }
    isBusy() {
        return this.busy;
    }
}
