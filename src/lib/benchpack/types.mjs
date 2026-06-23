// VENDORED from BenchAGI_Mono_Repo apps/web/src/lib/forge/benchpack — keep byte-identical to the server verifier (#2144).
//
// Forge Contribution Rail — `.benchpack` format & crypto CORE types (Phase 2).
//
// The `.benchpack` is the signed delivery artifact a contributor produces
// off-site and delivers into the Bench-owned quarantine gate. This module is
// the PURE type surface for that artifact: the manifest (the JCS-canonical
// signed payload), per-file content addressing, the detached ed25519
// signature, and the fail-closed verify result.
//
// The original is a TypeScript type module; in the `.mjs` CLI the interfaces
// become JSDoc typedefs and the ONE runtime value (BENCHPACK_SUPPORTED_MAJORS)
// is exported verbatim.
//
// Doctrine reference:
//   kestrel-aurelius/handoffs/forge-contribution-rail-2026-06-17.md §7.1–§7.2

/**
 * The supported `.benchpack` manifest major versions. A verifier accepts only
 * a KNOWN major version (fail-closed on anything else, §7.2 stage 1).
 *
 * @type {readonly number[]}
 */
export const BENCHPACK_SUPPORTED_MAJORS = [1];

/**
 * @typedef {`${number}.${number}`} BenchpackVersion
 *   The manifest version string format: `<major>.<minor>` (both non-negative
 *   integers). The major is parsed for the known-version gate.
 */

/**
 * @typedef {Object} BenchpackFile
 * @property {string} sha256  Lowercase-hex sha256 of the file's raw bytes.
 * @property {number} bytes   Decompressed byte length of the file.
 */

/**
 * @typedef {Object} BenchpackManifest
 * @property {string} version              `<major>.<minor>`; only a known major verifies (§7.2).
 * @property {string} packetId             The dispatched contribution/packet this delivery answers.
 * @property {string} baseContractHash     sha256 of the issued contract pack this was built against.
 * @property {string[]} declaredTouchedPaths The contributor's self-declared touched paths.
 * @property {Record<string, BenchpackFile>} files Per-file content addressing, keyed by repo-relative path.
 * @property {string} payloadRoot          Deterministic Merkle/sorted-hash root over every file's sha256.
 * @property {string} [toolchain]          Optional toolchain provenance.
 * @property {string} [deps]               Optional resolved dependency provenance string.
 */

/**
 * @typedef {Object} DetachedSignature
 * @property {'ed25519'} algo
 * @property {string} publicKey  base64 of the raw (32-byte) ed25519 public key.
 * @property {string} signature  base64 of the raw (64-byte) ed25519 signature.
 */

/**
 * @typedef {Object} VerifyResult
 * @property {boolean} ok                  True iff every ordered verify stage passed.
 * @property {VerifyStage} [failedStage]   The stage id at which verification first failed.
 * @property {string[]} findings           Human-readable findings (always present).
 */

/**
 * @typedef {('manifest-parse'|'signature'|'content-hash'|'path-safety'|'declared-paths'|'internal-ref-scan')} VerifyStage
 */
