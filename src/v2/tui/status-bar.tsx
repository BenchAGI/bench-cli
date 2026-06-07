// status-bar.tsx — the dense pinned bottom bar. Tightly-packed info critical to the decisions in
// flight: who you're talking to, on what model, your access tier, the session, live connection
// health, and a 🔔 when the agent is waiting on you. The segment assembly is a pure function
// (unit-tested); the ink component just paints it.

import { Box, Text } from "ink";
import { BRAND_HEX } from "../render/ansi.js";

export type HealthState = "idle" | "ok" | "reconnecting" | "unhealthy" | "stuck";

export type StatusBarState = {
  agentId: string;
  model?: string; // already shortened, e.g. "Opus 4.8"
  tier?: { level: string; color?: string }; // color = tier name ("Orange"/"Purple"/…)
  sessionShort?: string; // short session/resume id
  health: HealthState;
  pendingApproval?: boolean;
  thinking?: "on" | "off" | "collapsed";
  tokens?: number | null; // null/undefined → slot stays dark (NEVER fabricate)
};

export type StatusSegment = {
  key: string;
  text: string;
  color?: string;
  bold?: boolean;
  dim?: boolean;
};

// Tier name → display hex. Mirrors config/permissions.json tier colors.
const TIER_HEX: Record<string, string> = {
  orange: "#ff8c42",
  purple: "#a970ff",
  blue: "#4aa3ff",
  green: "#46d369",
  white: "#d8d8d8",
};

// Connection-health dot color + label.
const HEALTH: Record<HealthState, { color: string; label: string }> = {
  idle: { color: BRAND_HEX.dim, label: "idle" },
  ok: { color: "#46d369", label: "live" },
  reconnecting: { color: BRAND_HEX.amber, label: "reconnecting" },
  unhealthy: { color: BRAND_HEX.amber, label: "unhealthy" },
  stuck: { color: BRAND_HEX.infrared, label: "stuck" },
};

function cap(s: string): string {
  return s ? s[0]!.toUpperCase() + s.slice(1) : s;
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

// Pure: assemble the bar segments left→right. Order matches Cory's mockup:
// 🦅 agent · model · tier · sess · ●health · 🔔(if pending) · [tokens].
export function buildStatusSegments(s: StatusBarState): StatusSegment[] {
  const segs: StatusSegment[] = [];
  segs.push({ key: "agent", text: `🦅 ${cap(s.agentId)}`, color: BRAND_HEX.infrared, bold: true });
  if (s.model) segs.push({ key: "model", text: s.model, color: BRAND_HEX.copper });
  if (s.tier?.level) {
    const hex = s.tier.color ? TIER_HEX[s.tier.color.toLowerCase()] : undefined;
    segs.push({ key: "tier", text: s.tier.level, color: hex, bold: true });
  }
  if (s.sessionShort) segs.push({ key: "sess", text: `sess ${s.sessionShort}`, dim: true });
  const h = HEALTH[s.health];
  segs.push({ key: "health", text: `● ${h.label}`, color: h.color });
  if (s.pendingApproval) {
    segs.push({ key: "approval", text: "🔔 needs you", color: BRAND_HEX.amber, bold: true });
  }
  if (s.thinking === "off") segs.push({ key: "thinking", text: "think off", dim: true });
  else if (s.thinking === "collapsed") segs.push({ key: "thinking", text: "think ⊟", dim: true });
  // Token slot: only when the gateway actually reports usage. Until then it stays dark — no fake numbers.
  if (typeof s.tokens === "number") {
    segs.push({ key: "tokens", text: `${fmtTokens(s.tokens)} tok`, dim: true });
  }
  return segs;
}

export function StatusBar({ state, width }: { state: StatusBarState; width: number }): JSX.Element {
  const segs = buildStatusSegments(state);
  return (
    <Box width={width} borderStyle="single" borderColor={BRAND_HEX.dim} borderTop={true} borderBottom={false} borderLeft={false} borderRight={false} paddingX={1}>
      <Text wrap="truncate-end">
        {segs.map((seg, i) => (
          <Text key={seg.key}>
            {i > 0 ? <Text color={BRAND_HEX.dim}> · </Text> : null}
            <Text color={seg.color} bold={seg.bold} dimColor={seg.dim && !seg.color}>
              {seg.text}
            </Text>
          </Text>
        ))}
      </Text>
    </Box>
  );
}
