// VENDORED from BenchAGI_Mono_Repo apps/web/src/lib/forge/benchpack — keep byte-identical to the server verifier (#2144).
//
// Forge Contribution Rail — `verifyBenchpack` (Phase 2, security-critical).
//
// The fail-closed, ORDERED verifier (§7.2). It NEVER throws on bad input — any
// malformed manifest, key, signature, or payload resolves to
// `{ ok:false, failedStage, findings }`. `ok:true` is returned ONLY when every
// ordered stage passes.
//
// Vendored into the CLI so the contributor-side roundtrip test asserts against
// the SAME ordered logic the server runs (the contract a delivery must clear).
//
// Order (stop on first failure), per §7.2 — the stages this PURE crypto core
// owns (gz/tar validity + required-entries-present are tar/IO concerns owned by
// the transport layer, NOT here):
//
//   1. manifest-parse     — parses + KNOWN major version.
//   2. signature          — ed25519 verify over the CANONICAL manifest, BEFORE
//                           any payload byte is read (cheap-reject forgeries).
//   3. content-hash       — recompute every file sha256 + payloadRoot; assert
//                           === manifest. NO skip-hash fast path.
//   4. path-safety        — reject `..`, absolute, NUL, backslash, drive-letter.
//   5. declared-paths     — every payload path ∈ manifest.declaredTouchedPaths.
//   6. internal-ref-scan  — a small reused internal-ref content pattern.
//
// PURE: node:crypto + pure JS; no fs, no tar, no Firestore.

import { computePayloadRoot, sha256Hex } from "./content-address.mjs";
import { canonicalizeToBytes } from "./json-canonical.mjs";
import { parseManifest } from "./manifest.mjs";
import { verifyManifestSignature } from "./signing.mjs";

/**
 * @typedef {Record<string, { content: Buffer | Uint8Array | string }>} VerifyPayloadFiles
 *   The payload the verifier needs: the in-memory file contents by path.
 */

/**
 * @typedef {Object} VerifyBenchpackInput
 * @property {unknown} manifest
 * @property {VerifyPayloadFiles} files
 * @property {import('./types.mjs').DetachedSignature} signature
 * @property {import('./signing.mjs').PublicKeyInput} publicKey REQUIRED pinned key.
 */

/**
 * The reused internal-ref content pattern (§7.2 stage 6). A small, deliberately
 * conservative sweep mirroring the spec's `CUSTOMER_VISIBLE_INTERNAL_REF_PATTERN`
 * lineage: GitHub refs, the internal Forge announce channel, issue refs, the
 * tenant key prefixes, service-account / firebase config markers, the tailnet
 * CGNAT block, and `*.ts.net`. A hit FAILS closed — a contributor payload must
 * not smuggle internal references back in.
 */
const INTERNAL_REF_PATTERN =
  /github\.com|githubusercontent|#the_forge|issues\/\d+|\bbench_[a-z0-9-]+_|\bkestrel_|service-account|firebase(?:config|-adminsdk)|\b100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}\b|\.ts\.net\b/i;

/**
 * Verify a `.benchpack`. FAIL-CLOSED + ordered. Never throws.
 * @param {VerifyBenchpackInput} input
 * @returns {import('./types.mjs').VerifyResult}
 */
export function verifyBenchpack(input) {
  try {
    return runVerify(input);
  } catch (err) {
    // A defensive backstop: NOTHING in runVerify should throw, but if some
    // unforeseen input shape does, we still fail closed rather than propagate.
    return {
      ok: false,
      failedStage: "manifest-parse",
      findings: [
        `verifyBenchpack: unexpected error treated as failure: ${stringifyError(err)}`,
      ],
    };
  }
}

function runVerify(input) {
  // Defend against a non-object input envelope up front.
  if (input === null || typeof input !== "object") {
    return fail("manifest-parse", ["input envelope is not an object"]);
  }
  const { manifest: rawManifest, files, signature, publicKey } = input;

  // ── Stage 1: manifest parses + known major version ──────────────────────
  let manifest;
  try {
    manifest = parseManifest(rawManifest);
  } catch (err) {
    return fail("manifest-parse", [stringifyError(err)]);
  }

  // ── Stage 2: signature verifies over the CANONICAL manifest, BEFORE any
  //            payload byte is read (cheap-reject forgeries). ───────────────
  if (!signature || typeof signature !== "object") {
    return fail("signature", ["missing or non-object signature"]);
  }
  // The pinned key is mandatory: the gate must verify against a REGISTERED key,
  // never the bundle's own embedded key (which a forger controls). Fail closed.
  if (publicKey === undefined || publicKey === null) {
    return fail("signature", [
      "no trusted public key pinned — verifyBenchpack requires a registered forgeContributorKeys key",
    ]);
  }
  let canonicalBytes;
  try {
    // Verify the signature over the delivered manifest value, not the sanitized
    // parsed copy. Otherwise an attacker could append unsigned unknown fields
    // that parseManifest drops before canonicalization.
    canonicalBytes = canonicalizeToBytes(rawManifest);
  } catch (err) {
    // A manifest that cannot be canonicalized cannot be signature-checked.
    return fail("signature", [
      `manifest is not canonicalizable: ${stringifyError(err)}`,
    ]);
  }
  const sigOk = verifyManifestSignature(canonicalBytes, signature, publicKey);
  if (!sigOk) {
    return fail("signature", [
      "ed25519 signature did not verify over the canonical manifest",
    ]);
  }

  // ── Stage 3: recompute every file sha256 + payloadRoot; assert === manifest.
  if (files === null || typeof files !== "object") {
    return fail("content-hash", ["payload files map is not an object"]);
  }

  const manifestPaths = Object.keys(manifest.files);
  const payloadPaths = Object.keys(files);

  // Set-equality between declared files and supplied payload files.
  const missingFromPayload = manifestPaths.filter((p) => !(p in files));
  if (missingFromPayload.length > 0) {
    return fail("content-hash", [
      `payload missing files declared in manifest: ${missingFromPayload.join(", ")}`,
    ]);
  }
  const extraInPayload = payloadPaths.filter((p) => !(p in manifest.files));
  if (extraInPayload.length > 0) {
    return fail("content-hash", [
      `payload has files not declared in manifest: ${extraInPayload.join(", ")}`,
    ]);
  }

  // Recompute each file's sha256 (+ length) and compare to the manifest entry.
  const recomputed = {};
  for (const path of manifestPaths) {
    const declared = manifest.files[path];
    const supplied = files[path];
    if (
      supplied === null ||
      typeof supplied !== "object" ||
      !("content" in supplied)
    ) {
      return fail("content-hash", [`payload entry "${path}" has no content`]);
    }
    const content = supplied.content;
    const buf =
      typeof content === "string"
        ? Buffer.from(content, "utf8")
        : Buffer.from(content);
    const sha = sha256Hex(buf);
    if (sha !== declared.sha256) {
      return fail("content-hash", [
        `sha256 mismatch for "${path}" (declared ${declared.sha256}, actual ${sha})`,
      ]);
    }
    if (buf.byteLength !== declared.bytes) {
      return fail("content-hash", [
        `byte-length mismatch for "${path}" (declared ${declared.bytes}, actual ${buf.byteLength})`,
      ]);
    }
    recomputed[path] = { sha256: sha, bytes: buf.byteLength };
  }

  // Recompute the payloadRoot from the recomputed leaves and assert it matches.
  const recomputedRoot = computePayloadRoot(recomputed);
  if (recomputedRoot !== manifest.payloadRoot) {
    return fail("content-hash", [
      `payloadRoot mismatch (declared ${manifest.payloadRoot}, actual ${recomputedRoot})`,
    ]);
  }

  // ── Stage 4: path-safety sweep over EVERY payload path. ──────────────────
  for (const path of payloadPaths) {
    const finding = unsafePathFinding(path);
    if (finding) {
      return fail("path-safety", [finding]);
    }
  }
  // Also sweep the declared set.
  for (const path of manifest.declaredTouchedPaths) {
    const finding = unsafePathFinding(path);
    if (finding) {
      return fail("path-safety", [`declaredTouchedPaths: ${finding}`]);
    }
  }

  // ── Stage 5: declaredTouchedPaths and payload paths are set-equal. ───────
  const declaredSet = new Set(manifest.declaredTouchedPaths);
  if (declaredSet.size !== manifest.declaredTouchedPaths.length) {
    return fail("declared-paths", [
      "declaredTouchedPaths contains duplicate entries",
    ]);
  }

  const undeclared = payloadPaths.filter((p) => !declaredSet.has(p));
  if (undeclared.length > 0) {
    return fail("declared-paths", [
      `payload paths not in declaredTouchedPaths: ${undeclared.join(", ")}`,
    ]);
  }
  const declaredWithoutPayload = manifest.declaredTouchedPaths.filter(
    (p) => !(p in files),
  );
  if (declaredWithoutPayload.length > 0) {
    return fail("declared-paths", [
      `declaredTouchedPaths not present in payload: ${declaredWithoutPayload.join(", ")}`,
    ]);
  }

  // ── Stage 6: internal-ref content scan over every payload file. ──────────
  for (const path of payloadPaths) {
    const content = files[path].content;
    const text =
      typeof content === "string"
        ? content
        : Buffer.from(content).toString("utf8");
    const match = INTERNAL_REF_PATTERN.exec(text);
    if (match) {
      return fail("internal-ref-scan", [
        `internal reference detected in "${path}": ${redactMatch(match[0])}`,
      ]);
    }
  }

  // ── All stages passed. ───────────────────────────────────────────────────
  return { ok: true, findings: [] };
}

// ─── stage helpers ───────────────────────────────────────────────────────────

/**
 * Return a finding string if `path` is unsafe, else null. Rejects:
 *   - empty paths;
 *   - NUL bytes anywhere;
 *   - backslashes (Windows-style / path confusion);
 *   - absolute POSIX paths (`/...`);
 *   - drive-letter / UNC absolutes (`C:\`, `c:/`);
 *   - any `..` traversal segment;
 *   - a leading `./` or bare `.`/`..` segment.
 */
function unsafePathFinding(path) {
  if (typeof path !== "string" || path.length === 0) {
    return "empty or non-string path";
  }
  if (path.includes("\0")) {
    return `path contains NUL: ${JSON.stringify(path)}`;
  }
  if (path.includes("\\")) {
    return `path contains backslash: ${path}`;
  }
  if (path.startsWith("/")) {
    return `absolute path not allowed: ${path}`;
  }
  // Drive-letter absolute (C:, c:\, C:/) or any drive-letter prefix.
  if (/^[a-zA-Z]:/.test(path)) {
    return `drive-letter path not allowed: ${path}`;
  }
  // Split on forward slash and reject any traversal/empty/dot segment.
  const segments = path.split("/");
  for (const seg of segments) {
    if (seg === "..") {
      return `path traversal segment not allowed: ${path}`;
    }
    if (seg === ".") {
      return `dot segment not allowed: ${path}`;
    }
    if (seg === "") {
      return `empty path segment not allowed: ${path}`;
    }
  }
  return null;
}

function fail(stage, findings) {
  return { ok: false, failedStage: stage, findings };
}

function stringifyError(err) {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** Truncate a matched internal-ref snippet so findings don't echo a full secret. */
function redactMatch(s) {
  if (s.length <= 12) return s;
  return `${s.slice(0, 8)}…`;
}
