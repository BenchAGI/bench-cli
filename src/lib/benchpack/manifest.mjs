// VENDORED from BenchAGI_Mono_Repo apps/web/src/lib/forge/benchpack — keep byte-identical to the server verifier (#2144).
//
// Forge Contribution Rail — `.benchpack` manifest build & parse (Phase 2).
//
// `buildManifest` computes the per-file sha256 + byte length + the
// `payloadRoot` from raw file contents and assembles a `BenchpackManifest`.
// `parseManifest` validates an `unknown` (e.g. JSON.parse of an on-disk
// manifest) into a typed `BenchpackManifest` or throws — it does NOT recompute
// hashes (that is `verifyBenchpack`'s job; parse only checks SHAPE).
//
// PURE: no fs, no Firestore, no new deps.

import { computePayloadRoot, hashFile } from "./content-address.mjs";
import { BENCHPACK_SUPPORTED_MAJORS } from "./types.mjs";

/**
 * @typedef {Record<string, Buffer | Uint8Array | string>} ManifestFileContents
 *   Per-path raw file contents to build a manifest over.
 */

/**
 * @typedef {Object} BuildManifestMeta
 * @property {string} [version]
 * @property {string} packetId
 * @property {string} baseContractHash
 * @property {string[]} declaredTouchedPaths
 * @property {string} [toolchain]
 * @property {string} [deps]
 */

/** The default manifest version emitted by `buildManifest`. */
export const DEFAULT_BENCHPACK_VERSION = "1.0";

/**
 * Build a `BenchpackManifest` from raw file contents + caller metadata.
 * Computes each file's sha256 + byte length and the deterministic
 * `payloadRoot`. The result is ready to JCS-canonicalize and sign.
 *
 * @param {ManifestFileContents} files
 * @param {BuildManifestMeta} meta
 * @returns {import('./types.mjs').BenchpackManifest}
 */
export function buildManifest(files, meta) {
  const fileMap = {};
  for (const path of Object.keys(files)) {
    fileMap[path] = hashFile(files[path]);
  }

  return {
    version: meta.version ?? DEFAULT_BENCHPACK_VERSION,
    packetId: meta.packetId,
    baseContractHash: meta.baseContractHash,
    declaredTouchedPaths: [...meta.declaredTouchedPaths],
    files: fileMap,
    payloadRoot: computePayloadRoot(fileMap),
    ...(meta.toolchain !== undefined ? { toolchain: meta.toolchain } : {}),
    ...(meta.deps !== undefined ? { deps: meta.deps } : {}),
  };
}

/**
 * Parse & SHAPE-validate an unknown value into a `BenchpackManifest`. Throws a
 * descriptive Error on any structural problem (the fail-closed `verifyBenchpack`
 * catches this and reports `manifest-parse`).
 *
 * Validates: a known major version; required string/array/object fields; each
 * `files` entry is `{sha256: hex64, bytes: non-negative int}`; no unexpected
 * primitive shapes. Does NOT recompute hashes or check the signature.
 *
 * @param {unknown} input
 * @returns {import('./types.mjs').BenchpackManifest}
 */
export function parseManifest(input) {
  if (!isPlainObject(input)) {
    throw new Error("parseManifest: manifest is not an object");
  }

  const version = input.version;
  if (typeof version !== "string" || !isVersionString(version)) {
    throw new Error('parseManifest: missing/invalid "version"');
  }
  if (!isKnownMajor(version)) {
    throw new Error(`parseManifest: unsupported major version "${version}"`);
  }

  const packetId = input.packetId;
  if (typeof packetId !== "string" || packetId.length === 0) {
    throw new Error('parseManifest: missing/invalid "packetId"');
  }

  const baseContractHash = input.baseContractHash;
  if (typeof baseContractHash !== "string" || baseContractHash.length === 0) {
    throw new Error('parseManifest: missing/invalid "baseContractHash"');
  }

  const declaredTouchedPaths = input.declaredTouchedPaths;
  if (
    !Array.isArray(declaredTouchedPaths) ||
    !declaredTouchedPaths.every((p) => typeof p === "string")
  ) {
    throw new Error('parseManifest: "declaredTouchedPaths" must be string[]');
  }

  const payloadRoot = input.payloadRoot;
  if (typeof payloadRoot !== "string" || !isHex64(payloadRoot)) {
    throw new Error('parseManifest: missing/invalid "payloadRoot"');
  }

  const filesRaw = input.files;
  if (!isPlainObject(filesRaw)) {
    throw new Error('parseManifest: "files" must be an object');
  }
  const files = {};
  for (const path of Object.keys(filesRaw)) {
    const entry = filesRaw[path];
    if (!isPlainObject(entry)) {
      throw new Error(`parseManifest: file entry "${path}" is not an object`);
    }
    const sha256 = entry.sha256;
    const bytes = entry.bytes;
    if (typeof sha256 !== "string" || !isHex64(sha256)) {
      throw new Error(`parseManifest: file "${path}" has invalid sha256`);
    }
    if (
      typeof bytes !== "number" ||
      !Number.isInteger(bytes) ||
      bytes < 0
    ) {
      throw new Error(`parseManifest: file "${path}" has invalid bytes`);
    }
    files[path] = { sha256, bytes };
  }

  const toolchain = input.toolchain;
  if (toolchain !== undefined && typeof toolchain !== "string") {
    throw new Error('parseManifest: "toolchain" must be a string when present');
  }
  const deps = input.deps;
  if (deps !== undefined && typeof deps !== "string") {
    throw new Error('parseManifest: "deps" must be a string when present');
  }

  return {
    version: version,
    packetId,
    baseContractHash,
    declaredTouchedPaths: [...declaredTouchedPaths],
    files,
    payloadRoot,
    ...(toolchain !== undefined ? { toolchain } : {}),
    ...(deps !== undefined ? { deps } : {}),
  };
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function isPlainObject(value) {
  return (
    typeof value === "object" && value !== null && !Array.isArray(value)
  );
}

function isVersionString(v) {
  // `<non-negative int>.<non-negative int>`
  return /^\d+\.\d+$/.test(v);
}

function isKnownMajor(v) {
  const major = Number.parseInt(v.split(".")[0], 10);
  return BENCHPACK_SUPPORTED_MAJORS.includes(major);
}

function isHex64(s) {
  return /^[0-9a-f]{64}$/.test(s);
}
