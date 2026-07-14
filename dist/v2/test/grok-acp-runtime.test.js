import assert from "node:assert/strict";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { GrokAcpRuntime } from "../excalibur/grok-acp-runtime.js";
import { loadExcaliburState } from "../excalibur/scoped-state.js";
const FAKE_GROK = `#!/usr/bin/env node
if (process.argv.includes("--version")) {
  process.stdout.write("grok 9.9.9 (fake)\\n");
  process.exit(0);
}
const readline = await import("node:readline");
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let promptId = null;
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: {
      protocolVersion: 1,
      agentCapabilities: { sessionCapabilities: { close: {} }, loadSession: true }
    }});
    return;
  }
  if (message.method === "session/new") {
    send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "fake-native-session" } });
    return;
  }
  if (message.method === "session/prompt") {
    promptId = message.id;
    send({ jsonrpc: "2.0", id: 900, method: "session/request_permission", params: {
      sessionId: "fake-native-session",
      options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
      toolCall: { toolCallId: "effect-1", title: "write customer data", status: "pending" }
    }});
    return;
  }
  if (message.id === 900) {
    if (message.result?.outcome?.outcome !== "cancelled") process.exit(9);
    send({ jsonrpc: "2.0", method: "session/update", params: {
      sessionId: "fake-native-session",
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "effect locked" } }
    }});
    send({ jsonrpc: "2.0", id: promptId, result: { stopReason: "end_turn" } });
    return;
  }
  if (message.method === "session/close") {
    send({ jsonrpc: "2.0", id: message.id, result: {} });
    setTimeout(() => process.exit(0), 5);
  }
});
`;
test("legacy direct Grok ACP diagnostic denies permission requests and persists a scoped session", async () => {
    const root = await mkdtemp(join(tmpdir(), "excalibur-grok-acp-"));
    const sourceHome = join(root, "source-grok");
    const binDir = join(sourceHome, "bin");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(binDir, { recursive: true }));
    const binary = join(binDir, "grok.mjs");
    await writeFile(binary, FAKE_GROK, "utf8");
    await chmod(binary, 0o755);
    await writeFile(join(sourceHome, "models_cache.json"), JSON.stringify({ models: ["grok-4.5"] }));
    await writeFile(join(sourceHome, "auth.json"), JSON.stringify({ token: "fake" }), { mode: 0o600 });
    const env = {
        ...process.env,
        EXCALIBUR_GROK_SOURCE_HOME: sourceHome,
        EXCALIBUR_GROK_BIN: binary,
        EXCALIBUR_STATE_DIR: join(root, "state"),
    };
    const scope = {
        principalId: "principal-a",
        principalHash: "principal-a",
        instanceId: "instance-1",
        authenticated: true,
    };
    const runtime = new GrokAcpRuntime({ env, scope, contextId: "operator-local", showThinking: false });
    await runtime.connect();
    const runId = await runtime.sendMessage("hello");
    assert.ok(runId);
    assert.equal(await runtime.waitForFinal(3_000, runId), "final");
    const resumeKey = runtime.resumeKey();
    assert.ok(resumeKey);
    await runtime.close();
    const state = await loadExcaliburState({ scope, env });
    const session = state.sessions.find((item) => item.sessionId === resumeKey);
    assert.equal(session?.nativeSessionId, "fake-native-session");
    assert.equal(session?.status, "closed");
});
