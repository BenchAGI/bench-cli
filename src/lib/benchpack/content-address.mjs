// VENDORED from BenchAGI_Mono_Repo apps/web/src/lib/forge/benchpack — keep byte-identical to the server verifier (#2144).
//
// Forge Contribution Rail — content addressing for `.benchpack` (Phase 2).
//
// Per-file sha256 → deterministic Merkle/sorted-hash `payloadRoot` → the
// `benchpackId` (base32 of the canonical manifest's sha256). The manifest pins
// `payloadRoot`, so one signature over the canonical manifest transitively
// authenticates every payload byte (§7.1).
//
// PURE: node:crypto only, no fs, no new deps.

import { createHash } from "node:crypto";

import { canonicalizeToBytes } from "./json-canonical.mjs";

/**
 * Lowercase-hex sha256 of `data` (string treated as UTF-8).
 * @param {Buffer | Uint8Array | string} data
 * @returns {string}
 */
export function sha256Hex(data) {
  const buf =
    typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data);
  return createHash("sha256").update(buf).digest("hex");
}

/**
 * Build the per-file content-address entry for one payload file: its
 * lowercase-hex sha256 and its byte length.
 * @param {Buffer | Uint8Array | string} content
 * @returns {import('./types.mjs').BenchpackFile}
 */
export function hashFile(content) {
  const buf =
    typeof content === "string"
      ? Buffer.from(content, "utf8")
      : Buffer.from(content);
  return { sha256: sha256Hex(buf), bytes: buf.byteLength };
}

/**
 * Compute the deterministic `payloadRoot` over a file map.
 *
 * Design choice — a SORTED, domain-separated hash chain (a 1-level Merkle root
 * over the per-file leaves), order-independent by construction:
 *
 *   leaf_i   = sha256( "benchpack-file\0" || path_i || "\0" || sha256_i )
 *   root     = sha256( "benchpack-root\0" || leaf_0 || leaf_1 || ... )
 *
 * where the leaves are concatenated in ASCENDING path order. Properties:
 *   - Deterministic & order-independent: the same set of {path → sha256}
 *     always yields the same root regardless of `files` key insertion order
 *     (we sort the paths).
 *   - Changes iff a file changes: any added/removed/renamed path OR any change
 *     to a file's content sha256 changes exactly one (or more) leaf and thus
 *     the root. The `path` is bound into the leaf so a swap of two files'
 *     contents (without renaming) still changes both leaves.
 *   - Domain-separated: the `benchpack-file\0` / `benchpack-root\0` prefixes
 *     prevent any cross-construction collision (a leaf can never be mistaken
 *     for a root preimage).
 *
 * The `NUL` (`\0`) separators are unambiguous because repo-relative payload
 * paths and lowercase-hex shas never contain a NUL byte (the path-safety
 * sweep in `verify.ts` rejects NUL paths outright).
 *
 * @param {Record<string, import('./types.mjs').BenchpackFile>} files the manifest file map.
 * @returns {string}
 */
export function computePayloadRoot(files) {
  const paths = Object.keys(files).sort(compareCodeUnits);

  const rootHash = createHash("sha256");
  rootHash.update("benchpack-root\0");

  for (const path of paths) {
    const entry = files[path];
    const leaf = createHash("sha256")
      .update("benchpack-file\0")
      .update(path)
      .update("\0")
      .update(entry.sha256)
      .digest();
    rootHash.update(leaf);
  }

  return rootHash.digest("hex");
}

/**
 * The `.benchpack` id: `bp-` + base32(sha256(canonical manifest)).
 *
 * Canonicalizes the manifest via JCS, sha256's those bytes, and base32-encodes
 * the raw digest (RFC 4648 base32 alphabet, lowercased, no padding — a
 * filesystem/URL-safe, case-insensitive, fixed-length token). Because it rides
 * the CANONICAL manifest, the id is insensitive to manifest key order.
 *
 * @param {import('./types.mjs').BenchpackManifest} manifest
 * @returns {string}
 */
export function benchpackId(manifest) {
  const canonicalBytes = canonicalizeToBytes(manifest);
  const digest = createHash("sha256").update(canonicalBytes).digest();
  return `bp-${base32Encode(digest)}`;
}

// ─── helpers ─────────────────────────────────────────────────────────────────

/** RFC 4648 base32 alphabet, lowercased, NO padding. */
const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

/** Encode raw bytes as lowercase, unpadded RFC 4648 base32. */
function base32Encode(bytes) {
  let out = "";
  let buffer = 0;
  let bitsInBuffer = 0;

  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bitsInBuffer += 8;
    while (bitsInBuffer >= 5) {
      bitsInBuffer -= 5;
      const index = (buffer >> bitsInBuffer) & 0x1f;
      out += BASE32_ALPHABET[index];
    }
  }

  if (bitsInBuffer > 0) {
    const index = (buffer << (5 - bitsInBuffer)) & 0x1f;
    out += BASE32_ALPHABET[index];
  }

  return out;
}

/** UTF-16 code-unit compare (matches the JCS path-ordering rule). */
function compareCodeUnits(a, b) {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}
