// Tests for the unified launcher model registry.
import assert from "node:assert/strict";
import { test } from "node:test";

import { modelChoices, shortModel, CLAUDE_MODELS } from "../launcher/models.js";

test("Claude list includes Opus 4.8 and the 1M variant", () => {
  const labels = CLAUDE_MODELS.map((m) => m.label);
  assert.ok(labels.includes("Opus 4.8"));
  assert.ok(labels.includes("Opus 4.8 (1M)"));
  assert.equal(CLAUDE_MODELS.find((m) => m.label === "Opus 4.8 (1M)")?.value, "claude-opus-4-8[1m]");
  assert.ok(labels.includes("Opus 4.6"));
});

test("1M Opus is local-Claude only (gateway catalog can't parse [1m])", () => {
  assert.ok(modelChoices("local-claude").some((m) => m.value === "claude-opus-4-8[1m]"));
  for (const env of ["tunnel", "direct"] as const) {
    assert.ok(!modelChoices(env).some((m) => m.value === "claude-opus-4-8[1m]"), `${env} hides 1M`);
  }
});

test("Default is the first option in each env with no value", () => {
  for (const env of ["local-claude", "local-codex", "tunnel", "direct"] as const) {
    const first = modelChoices(env)[0]!;
    assert.equal(first.label, "Default");
    assert.equal(first.value, undefined);
  }
});

test("codex env yields codex models, not Claude", () => {
  const codex = modelChoices("local-codex").map((m) => m.label);
  assert.ok(codex.includes("GPT-5.5"));
  assert.ok(!codex.includes("Opus 4.8"));
});

test("shortModel resolves ids, the Haiku alias, and passes through unknowns", () => {
  assert.equal(shortModel("claude-opus-4-8"), "Opus 4.8");
  assert.equal(shortModel("claude-haiku-4-5-20251001"), "Haiku 4.5");
  assert.equal(shortModel("claude-haiku-4-5"), "Haiku 4.5"); // alias the gateway may report
  assert.equal(shortModel(undefined), "");
  assert.equal(shortModel("some-unknown-model"), "some-unknown-model");
});
