// Minimal mirror of OpenClaw's gateway protocol surface that benchagi
// V2 needs. The authoritative schema lives in the openclaw repo at
// src/gateway/protocol/schema/frames.ts —
// keep this file aligned. We re-derive shapes here rather than depend on
// the openclaw package because openclaw isn't published.
// Gateway requires v4 (MIN_CLIENT_PROTOCOL_VERSION = 4): chat deltas carry `deltaText`.
export const PROTOCOL_VERSION = 4;
export const GATEWAY_CLIENT_CAPS = {
    TOOL_EVENTS: "tool-events",
};
