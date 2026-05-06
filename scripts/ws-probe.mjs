// Minimal direct probe to verify the gateway protocol contract.
import WebSocket from "ws";
import { randomUUID } from "node:crypto";

const ws = new WebSocket("ws://127.0.0.1:18789");

ws.on("open", () => {
  console.log("[probe] open");
});

ws.on("message", (raw) => {
  const data = typeof raw === "string" ? raw : raw.toString();
  console.log("[probe] recv:", data.slice(0, 400));
  let msg;
  try { msg = JSON.parse(data); } catch { return; }
  if (msg?.type === "event" && msg.event === "connect.challenge") {
    const nonce = msg.payload?.nonce ?? "";
    const id = randomUUID();
    const params = {
      minProtocol: 3,
      maxProtocol: 3,
      client: {
        id: "cli",
        version: "1.0.0",
        platform: process.platform,
        mode: "ui",
      },
      caps: ["tool-events"],
      ...(process.env.OPENCLAW_GATEWAY_TOKEN ? { auth: { token: process.env.OPENCLAW_GATEWAY_TOKEN } } : {}),
    };
    console.log("[probe] sending connect req with params:", JSON.stringify(params));
    ws.send(JSON.stringify({ type: "req", id, method: "connect", params }));
  }
});

ws.on("error", (err) => console.log("[probe] error:", err.message));
ws.on("close", (code, reason) => {
  console.log("[probe] close:", code, reason?.toString?.() ?? "");
  process.exit(0);
});

setTimeout(() => {
  console.log("[probe] timeout");
  process.exit(1);
}, 5000);
