import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
// status-bar.tsx — the dense pinned bottom bar. Tightly-packed info critical to the decisions in
// flight: who you're talking to, on what model, your access tier, the session, live connection
// health, and a 🔔 when the agent is waiting on you. The segment assembly is a pure function
// (unit-tested); the ink component just paints it.
import { Box, Text } from "ink";
import { BRAND_HEX } from "../render/ansi.js";
// Tier name → display hex. Mirrors config/permissions.json tier colors.
const TIER_HEX = {
    orange: "#ff8c42",
    purple: "#a970ff",
    blue: "#4aa3ff",
    green: "#46d369",
    white: "#d8d8d8",
};
// Connection-health dot color + label.
const HEALTH = {
    idle: { color: BRAND_HEX.dim, label: "idle" },
    ok: { color: "#46d369", label: "live" },
    reconnecting: { color: BRAND_HEX.amber, label: "reconnecting" },
    unhealthy: { color: BRAND_HEX.amber, label: "unhealthy" },
    stuck: { color: BRAND_HEX.infrared, label: "stuck" },
};
function cap(s) {
    return s ? s[0].toUpperCase() + s.slice(1) : s;
}
function fmtTokens(n) {
    if (n >= 1_000_000)
        return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000)
        return `${Math.round(n / 1_000)}k`;
    return String(n);
}
// Pure: assemble the bar segments left→right. Order matches Cory's mockup:
// 🦅 agent · model · tier · sess · ●health · 🔔(if pending) · [tokens].
export function buildStatusSegments(s) {
    const segs = [];
    segs.push({ key: "agent", text: `🦅 ${cap(s.agentId)}`, color: BRAND_HEX.infrared, bold: true });
    if (s.model)
        segs.push({ key: "model", text: s.model, color: BRAND_HEX.copper });
    if (s.tier?.level) {
        const hex = s.tier.color ? TIER_HEX[s.tier.color.toLowerCase()] : undefined;
        segs.push({ key: "tier", text: s.tier.level, color: hex, bold: true });
    }
    if (s.sessionShort)
        segs.push({ key: "sess", text: `sess ${s.sessionShort}`, dim: true });
    const h = HEALTH[s.health];
    segs.push({ key: "health", text: `● ${h.label}`, color: h.color });
    if (s.pendingApproval) {
        segs.push({ key: "approval", text: "🔔 needs you", color: BRAND_HEX.amber, bold: true });
    }
    if (s.thinking === "off")
        segs.push({ key: "thinking", text: "think off", dim: true });
    else if (s.thinking === "collapsed")
        segs.push({ key: "thinking", text: "think ⊟", dim: true });
    // Token slot: only when the gateway actually reports usage. Until then it stays dark — no fake numbers.
    if (typeof s.tokens === "number") {
        segs.push({ key: "tokens", text: `${fmtTokens(s.tokens)} tok`, dim: true });
    }
    return segs;
}
export function StatusBar({ state, width }) {
    const segs = buildStatusSegments(state);
    return (_jsx(Box, { width: width, paddingX: 1, children: _jsx(Text, { wrap: "truncate-end", children: segs.map((seg, i) => (_jsxs(Text, { children: [i > 0 ? _jsx(Text, { color: BRAND_HEX.dim, children: " \u00B7 " }) : null, _jsx(Text, { color: seg.color, bold: seg.bold, dimColor: seg.dim && !seg.color, children: seg.text })] }, seg.key))) }) }));
}
