// VENDORED from BenchAGI_Mono_Repo apps/web/src/lib/forge/benchpack — keep byte-identical to the server verifier (#2144).
//
// Forge Contribution Rail — ed25519 signing for `.benchpack` (Phase 2).
//
// NATIVE `node:crypto` ed25519 ONLY — no new dependency (guardrail). The
// `.benchpack` manifest is signed with a detached ed25519 signature computed
// over the JCS-CANONICAL manifest bytes (never the raw on-disk JSON).
//
// ── Key & signature encoding (documented) ────────────────────────────────────
//
// ed25519 keys have a fixed raw size: a 32-byte public key, a 32-byte private
// seed (64-byte signature). To stay portable across the contributor CLI and
// the Bench verifier we accept BOTH wire forms and normalize internally:
//
//   Public key, accepted on verify (`coercePublicKey`):
//     - a `KeyObject` (asymmetric, type 'public');
//     - a 32-byte raw key as a Buffer/Uint8Array, or its base64 / hex string;
//     - a PEM SPKI string (`-----BEGIN PUBLIC KEY-----`);
//     - a DER SPKI Buffer.
//
//   Private key, accepted on sign (`coercePrivateKey`):
//     - a `KeyObject` (asymmetric, type 'private');
//     - a 32-byte raw seed as a Buffer/Uint8Array, or its base64 / hex string;
//     - a PEM PKCS#8 string (`-----BEGIN PRIVATE KEY-----`);
//     - a DER PKCS#8 Buffer.
//
//   The DetachedSignature on the wire (`signManifest`):
//     - `publicKey` — base64 of the 32-byte RAW ed25519 public key.
//     - `signature` — base64 of the 64-byte RAW ed25519 signature.
//
// Raw 32-byte ed25519 keys are wrapped into the minimal SPKI/PKCS#8 DER prefix
// for node:crypto, which has no first-class raw-ed25519 import. The fixed DER
// prefixes below are the standard ed25519 OID (1.3.101.112) wrappers.
//
// FAIL-CLOSED: every verify path returns `false` (never throws) on a malformed
// signature, key, or message — see `verifyManifestSignature`.

import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as edSign,
  verify as edVerify,
} from "node:crypto";

/**
 * @typedef {import('node:crypto').KeyObject | Buffer | Uint8Array | string} PublicKeyInput
 * @typedef {import('node:crypto').KeyObject | Buffer | Uint8Array | string} PrivateKeyInput
 */

/**
 * @typedef {Object} ContributorKeypair
 * @property {import('node:crypto').KeyObject} privateKey  node KeyObject (private).
 * @property {import('node:crypto').KeyObject} publicKey   node KeyObject (public).
 * @property {string} publicKeyBase64   base64 of the 32-byte raw public key (the wire form).
 * @property {string} privateKeyBase64  base64 of the 32-byte raw private seed (store securely; never ships).
 * @property {string} publicKeyPem      PEM SPKI public key.
 * @property {string} privateKeyPem     PEM PKCS#8 private key.
 */

// Standard DER prefixes for raw ed25519 key wrapping (OID 1.3.101.112).
// SPKI header for a 32-byte ed25519 public key (12 bytes), then the 32 bytes.
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
// PKCS#8 header for a 32-byte ed25519 private seed (16 bytes), then the seed.
const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

const RAW_ED25519_KEY_LEN = 32;

/**
 * Generate a fresh ed25519 contributor keypair.
 * @returns {ContributorKeypair}
 */
export function generateContributorKeypair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");

  const spki = publicKey.export({ format: "der", type: "spki" });
  const pkcs8 = privateKey.export({ format: "der", type: "pkcs8" });
  const rawPublic = spki.subarray(spki.length - RAW_ED25519_KEY_LEN);
  const rawPrivate = pkcs8.subarray(pkcs8.length - RAW_ED25519_KEY_LEN);

  return {
    privateKey,
    publicKey,
    publicKeyBase64: Buffer.from(rawPublic).toString("base64"),
    privateKeyBase64: Buffer.from(rawPrivate).toString("base64"),
    publicKeyPem: publicKey.export({ format: "pem", type: "spki" }).toString(),
    privateKeyPem: privateKey
      .export({ format: "pem", type: "pkcs8" })
      .toString(),
  };
}

/**
 * Sign the CANONICAL manifest bytes with a private key, producing a detached
 * ed25519 signature (with the public key embedded for self-describing verify).
 *
 * `canonicalManifestBytes` MUST be the JCS-canonical bytes
 * (`canonicalizeToBytes(manifest)`), NOT the raw on-disk JSON — the verifier
 * recomputes the canonical bytes and checks the signature over those.
 *
 * @param {Buffer | Uint8Array} canonicalManifestBytes
 * @param {PrivateKeyInput} privateKey
 * @returns {import('./types.mjs').DetachedSignature}
 */
export function signManifest(canonicalManifestBytes, privateKey) {
  const key = coercePrivateKey(privateKey);
  const message = Buffer.from(canonicalManifestBytes);
  // ed25519 is a pure (non-prehash) signature: pass `null` for the algorithm.
  const signature = edSign(null, message, key);

  // Derive the matching public key so the signature is self-describing.
  const pub = createPublicKey(key);
  const spki = pub.export({ format: "der", type: "spki" });
  const rawPublic = spki.subarray(spki.length - RAW_ED25519_KEY_LEN);

  return {
    algo: "ed25519",
    publicKey: Buffer.from(rawPublic).toString("base64"),
    signature: signature.toString("base64"),
  };
}

/**
 * Verify a detached ed25519 signature over the CANONICAL manifest bytes.
 *
 * FAIL-CLOSED: returns `false` (never throws) for ANY malformed input — a bad
 * base64 blob, a wrong-length key/signature, a non-ed25519 `algo`, a key that
 * cannot be imported, or a genuine signature mismatch. Only a cryptographically
 * valid signature by `publicKey` over exactly these bytes returns `true`.
 *
 * @param {Buffer | Uint8Array} canonicalManifestBytes
 * @param {import('./types.mjs').DetachedSignature} signature
 * @param {PublicKeyInput} [publicKey] OPTIONAL override; when omitted the embedded
 *   `signature.publicKey` is used.
 * @returns {boolean}
 */
export function verifyManifestSignature(
  canonicalManifestBytes,
  signature,
  publicKey,
) {
  try {
    if (!signature || typeof signature !== "object") return false;
    if (signature.algo !== "ed25519") return false;
    if (typeof signature.signature !== "string" || signature.signature === "") {
      return false;
    }

    const sigBytes = decodeBase64Strict(signature.signature);
    if (sigBytes === null || sigBytes.length !== 64) return false;

    const keyInput = publicKey ?? signature.publicKey;
    if (keyInput === undefined || keyInput === null) return false;

    const key = coercePublicKey(keyInput);
    const message = Buffer.from(canonicalManifestBytes);

    return edVerify(null, message, key, sigBytes);
  } catch {
    // Any import/parse/verify error is a verification FAILURE, never a throw.
    return false;
  }
}

// ─── key coercion ────────────────────────────────────────────────────────────

/**
 * Coerce any accepted public-key form to a node KeyObject. Throws on garbage.
 * @param {PublicKeyInput} input
 * @returns {import('node:crypto').KeyObject}
 */
export function coercePublicKey(input) {
  if (isKeyObject(input)) {
    if (input.type !== "public") {
      // Allow a private KeyObject to yield its public half (convenience).
      if (input.type === "private") return createPublicKey(input);
      throw new Error("coercePublicKey: KeyObject is not a public key");
    }
    return input;
  }

  if (typeof input === "string") {
    const trimmed = input.trim();
    if (trimmed.includes("-----BEGIN")) {
      return createPublicKey({ key: trimmed, format: "pem" });
    }
    const raw = decodeRawEd25519KeyString(trimmed);
    if (raw && raw.length === RAW_ED25519_KEY_LEN) {
      return publicKeyFromRaw(raw);
    }
    throw new Error("coercePublicKey: unrecognized public key string");
  }

  const buf = Buffer.from(input);
  if (buf.length === RAW_ED25519_KEY_LEN) {
    return publicKeyFromRaw(buf);
  }
  // Otherwise assume DER SPKI.
  return createPublicKey({ key: buf, format: "der", type: "spki" });
}

/**
 * Coerce any accepted private-key form to a node KeyObject. Throws on garbage.
 * @param {PrivateKeyInput} input
 * @returns {import('node:crypto').KeyObject}
 */
export function coercePrivateKey(input) {
  if (isKeyObject(input)) {
    if (input.type !== "private") {
      throw new Error("coercePrivateKey: KeyObject is not a private key");
    }
    return input;
  }

  if (typeof input === "string") {
    const trimmed = input.trim();
    if (trimmed.includes("-----BEGIN")) {
      return createPrivateKey({ key: trimmed, format: "pem" });
    }
    const raw = decodeRawEd25519KeyString(trimmed);
    if (raw && raw.length === RAW_ED25519_KEY_LEN) {
      return privateKeyFromRaw(raw);
    }
    throw new Error("coercePrivateKey: unrecognized private key string");
  }

  const buf = Buffer.from(input);
  if (buf.length === RAW_ED25519_KEY_LEN) {
    return privateKeyFromRaw(buf);
  }
  // Otherwise assume DER PKCS#8.
  return createPrivateKey({ key: buf, format: "der", type: "pkcs8" });
}

function publicKeyFromRaw(raw) {
  const der = Buffer.concat([ED25519_SPKI_PREFIX, raw]);
  return createPublicKey({ key: der, format: "der", type: "spki" });
}

function privateKeyFromRaw(raw) {
  const der = Buffer.concat([ED25519_PKCS8_PREFIX, raw]);
  return createPrivateKey({ key: der, format: "der", type: "pkcs8" });
}

function isKeyObject(value) {
  return (
    typeof value === "object" &&
    value !== null &&
    "asymmetricKeyType" in value &&
    typeof value.export === "function"
  );
}

/**
 * Strict base64 decode: returns null if the input is not valid base64 (so a
 * forged/garbage signature blob fails closed rather than silently decoding to
 * the wrong bytes). node's Buffer.from(..,'base64') is lenient, so we
 * round-trip to confirm the canonical re-encoding matches.
 */
function decodeBase64Strict(s) {
  if (typeof s !== "string" || s.length === 0) return null;
  // Reject any char outside the base64 alphabet up front.
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(s)) return null;
  const buf = Buffer.from(s, "base64");
  // Round-trip check (canonicalizes padding) to reject malformed-but-lenient.
  if (buf.toString("base64").replace(/=+$/, "") !== s.replace(/=+$/, "")) {
    return null;
  }
  return buf;
}

/** Decode a raw 32-byte ed25519 key string in hex or strict base64 form. */
function decodeRawEd25519KeyString(s) {
  if (/^[0-9a-fA-F]{64}$/.test(s)) {
    return Buffer.from(s, "hex");
  }

  const b64 = decodeBase64Strict(s);
  if (b64 && b64.length === RAW_ED25519_KEY_LEN) {
    return b64;
  }

  return null;
}
