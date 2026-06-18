// VENDORED from BenchAGI_Mono_Repo apps/web/src/lib/forge/benchpack — keep byte-identical to the server verifier (#2144).
//
// Forge Contribution Rail — `.benchpack` crypto + format CORE (Phase 2), the
// contributor-side barrel. A PURE, fail-closed library for the signed delivery
// artifact: JCS-canonical serialization, content addressing (per-file sha256 →
// Merkle payloadRoot → benchpackId), native node:crypto ed25519 signing/verify,
// manifest build/parse, and the ordered fail-closed `verifyBenchpack`.

export { BENCHPACK_SUPPORTED_MAJORS } from "./types.mjs";

export { canonicalize, canonicalizeToBytes } from "./json-canonical.mjs";

export {
  sha256Hex,
  hashFile,
  computePayloadRoot,
  benchpackId,
} from "./content-address.mjs";

export {
  generateContributorKeypair,
  signManifest,
  verifyManifestSignature,
  coercePublicKey,
  coercePrivateKey,
} from "./signing.mjs";

export {
  buildManifest,
  parseManifest,
  DEFAULT_BENCHPACK_VERSION,
} from "./manifest.mjs";

export { verifyBenchpack } from "./verify.mjs";
