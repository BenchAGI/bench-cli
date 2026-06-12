import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  containsMouseEvent,
  installTuiScreenMode,
  mouseWheelDelta,
} from "../tui/terminal-events.js";

test("mouseWheelDelta reads SGR wheel up and down packets", () => {
  assert.equal(mouseWheelDelta("\x1b[<64;10;5M"), 1);
  assert.equal(mouseWheelDelta("\x1b[<65;10;5M"), -1);
  assert.equal(mouseWheelDelta("\x1b[<64;10;5M\x1b[<64;10;5M\x1b[<65;10;5M"), 1);
});

test("mouseWheelDelta tolerates modifier bits on SGR wheel packets", () => {
  assert.equal(mouseWheelDelta("\x1b[<68;10;5M"), 1);
  assert.equal(mouseWheelDelta("\x1b[<69;10;5M"), -1);
});

test("mouseWheelDelta reads X10 wheel packets", () => {
  assert.equal(mouseWheelDelta(`\x1b[M${String.fromCharCode(96)}!!`), 1);
  assert.equal(mouseWheelDelta(`\x1b[M${String.fromCharCode(97)}!!`), -1);
});

test("containsMouseEvent detects mouse packets without matching normal escape keys", () => {
  assert.equal(containsMouseEvent("\x1b[<64;10;5M"), true);
  assert.equal(containsMouseEvent(`\x1b[M${String.fromCharCode(96)}!!`), true);
  assert.equal(containsMouseEvent("\x1b[A"), false);
});

test("installTuiScreenMode writes enter/exit controls for a tty stream", () => {
  const writes: string[] = [];
  const restore = installTuiScreenMode({ isTTY: true, write: (chunk) => writes.push(chunk) });
  assert.match(writes.join(""), /\x1b\[\?1049h/);
  assert.match(writes.join(""), /\x1b\[\?1006h/);
  restore();
  restore();
  const output = writes.join("");
  assert.match(output, /\x1b\[\?1006l/);
  assert.match(output, /\x1b\[\?1049l/);
  assert.equal(writes.length, 2, "restore is idempotent");
});

test("installTuiScreenMode is a no-op for non-tty streams", () => {
  const writes: string[] = [];
  const restore = installTuiScreenMode({ isTTY: false, write: (chunk) => writes.push(chunk) });
  restore();
  assert.deepEqual(writes, []);
});
