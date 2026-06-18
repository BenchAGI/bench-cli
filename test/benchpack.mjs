// Compatibility tests for the vendored `.benchpack` producer (src/lib/benchpack).
//
// These are the CONTRACT that a `bench forge` delivery must clear — the signing,
// canonicalization, payloadRoot, and benchpackId here are byte-for-byte the same
// algorithm the server's verifyBenchpack runs (#2144). A divergence = the server
// rejects every delivery, so these tests pin the exact bytes.
//
// node test runner: `node --test test/benchpack.mjs` (also run by `npm test`).
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";

import {
  buildManifest,
  canonicalize,
  canonicalizeToBytes,
  computePayloadRoot,
  benchpackId,
  sha256Hex,
  hashFile,
  signManifest,
  verifyManifestSignature,
  verifyBenchpack,
  parseManifest,
} from "../src/lib/benchpack/index.mjs";

// ─── 1. Self-roundtrip: build → sign → VERIFY (the server's ordered logic) ────

test("self-roundtrip: a CLI-built, ed25519-signed .benchpack verifies", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ format: "der", type: "spki" });
  const pubB64 = Buffer.from(spki.subarray(spki.length - 32)).toString("base64");
  const privPem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();

  const contents = {
    "src/feature.ts": "export function add(a, b) { return a + b; }\n",
    "tests/feature.test.ts": 'import { add } from "../src/feature";\n',
    "README.md": "# Contribution\n",
  };
  const manifest = buildManifest(contents, {
    packetId: "fp_roundtrip",
    baseContractHash: "c".repeat(64),
    declaredTouchedPaths: Object.keys(contents),
    toolchain: "node-26 pnpm-9",
  });

  // Sign the JCS-canonical bytes with the PEM key (what `bench forge pack` does).
  const signature = signManifest(canonicalizeToBytes(manifest), privPem);

  // Build the wire envelope exactly like the CLI emits it.
  const files = {};
  for (const [p, ctnt] of Object.entries(contents)) files[p] = { content: ctnt };

  // VERIFY against the PINNED public key — the server's verifyBenchpack contract.
  const r = verifyBenchpack({ manifest, files, signature, publicKey: pubB64 });
  assert.equal(r.ok, true, `expected ok, got ${JSON.stringify(r)}`);
  assert.deepEqual(r.findings, []);

  // The detached signature must also verify directly over the canonical bytes
  // (raw base64 pubkey AND the embedded one).
  assert.equal(
    verifyManifestSignature(canonicalizeToBytes(manifest), signature, pubB64),
    true,
  );
  assert.equal(
    verifyManifestSignature(canonicalizeToBytes(manifest), signature),
    true,
    "embedded-key self-verify",
  );
});

test("self-roundtrip: survives a JSON round-trip (canonicalization is stable)", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ format: "der", type: "spki" });
  const pubB64 = Buffer.from(spki.subarray(spki.length - 32)).toString("base64");

  const contents = { "src/a.ts": "a\n", "src/b.ts": "b\n" };
  const manifest = buildManifest(contents, {
    packetId: "fp_rt",
    baseContractHash: "d".repeat(64),
    declaredTouchedPaths: Object.keys(contents),
  });
  const signature = signManifest(canonicalizeToBytes(manifest), privateKey);

  // Serialize the WHOLE envelope to JSON and parse it back (the wire trip).
  const files = {};
  for (const [p, ctnt] of Object.entries(contents)) files[p] = { content: ctnt };
  const wire = JSON.parse(JSON.stringify({ manifest, files, signature }));

  const parsed = parseManifest(wire.manifest);
  assert.deepEqual(parsed, manifest);
  const r = verifyBenchpack({
    manifest: wire.manifest,
    files: wire.files,
    signature: wire.signature,
    publicKey: pubB64,
  });
  assert.equal(r.ok, true, JSON.stringify(r));
});

test("verify fails closed: tampered file → content-hash, bad sig → signature", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ format: "der", type: "spki" });
  const pubB64 = Buffer.from(spki.subarray(spki.length - 32)).toString("base64");

  const contents = { "src/a.ts": "a\n", "src/b.ts": "b\n" };
  const manifest = buildManifest(contents, {
    packetId: "p",
    baseContractHash: "e".repeat(64),
    declaredTouchedPaths: Object.keys(contents),
  });
  const signature = signManifest(canonicalizeToBytes(manifest), privateKey);
  const files = {};
  for (const [p, ctnt] of Object.entries(contents)) files[p] = { content: ctnt };

  const tampered = { ...files, "src/a.ts": { content: "TAMPERED\n" } };
  const r1 = verifyBenchpack({ manifest, files: tampered, signature, publicKey: pubB64 });
  assert.equal(r1.ok, false);
  assert.equal(r1.failedStage, "content-hash");

  const brokenSig = { ...signature, signature: Buffer.alloc(64, 7).toString("base64") };
  const r2 = verifyBenchpack({ manifest, files, signature: brokenSig, publicKey: pubB64 });
  assert.equal(r2.ok, false);
  assert.equal(r2.failedStage, "signature");
});

// ─── 2. Golden canonical manifest + payloadRoot (the server contract) ─────────
//
// Cross-checked against the ORIGINAL TypeScript lib at
// apps/web/src/lib/forge/benchpack — these bytes are byte-identical to what the
// server's verifyBenchpack canonicalizes & signs. If a future edit to the
// vendored lib changes these, the test FAILS LOUDLY: the change has broken
// server compatibility and every delivery would be rejected.

const GOLDEN_FILES = {
  // Deliberately UNSORTED insertion order — canonicalization MUST sort object
  // keys (so README.md sorts before src/alpha.ts before src/zeta.ts).
  "src/zeta.ts": "z\n",
  "src/alpha.ts": "a\n",
  "README.md": "# r\n",
};
const GOLDEN_META = {
  packetId: "fp_golden",
  baseContractHash: "b".repeat(64),
  // Array order is PRESERVED by JCS (arrays are not reordered, only object keys).
  declaredTouchedPaths: ["src/zeta.ts", "src/alpha.ts", "README.md"],
  toolchain: "node-26",
};

const GOLDEN_CANONICAL =
  '{"baseContractHash":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","declaredTouchedPaths":["src/zeta.ts","src/alpha.ts","README.md"],"files":{"README.md":{"bytes":4,"sha256":"054df7e3c2b056666d6db37722202825c4cf6bd477f1198ee7bf1b85136db54c"},"src/alpha.ts":{"bytes":2,"sha256":"87428fc522803d31065e7bce3cf03fe475096631e5e07bbd7a0fde60c4cf25c7"},"src/zeta.ts":{"bytes":2,"sha256":"c865f6c5ab8d1b0bcd383a5e1e3879d22681c96bf462c269b7581d523fbe70ab"}},"packetId":"fp_golden","payloadRoot":"269fdb7dbf5a3bc454a1ae57548679173c5c03446ea7bc2e21360ef74bdb0f79","toolchain":"node-26","version":"1.0"}';
const GOLDEN_PAYLOAD_ROOT =
  "269fdb7dbf5a3bc454a1ae57548679173c5c03446ea7bc2e21360ef74bdb0f79";
const GOLDEN_BENCHPACK_ID =
  "bp-jfim23h657g742kv2x2t3tfvz4k7gygabnum4hytupwmg27gnpbq";

test("golden: canonical manifest string is byte-stable (server contract)", () => {
  const m = buildManifest(GOLDEN_FILES, GOLDEN_META);
  assert.equal(canonicalize(m), GOLDEN_CANONICAL);
});

test("golden: payloadRoot is byte-stable", () => {
  const m = buildManifest(GOLDEN_FILES, GOLDEN_META);
  assert.equal(m.payloadRoot, GOLDEN_PAYLOAD_ROOT);
  // payloadRoot is order-independent over the file map.
  const fileMap = m.files;
  assert.equal(computePayloadRoot(fileMap), GOLDEN_PAYLOAD_ROOT);
});

test("golden: benchpackId is byte-stable", () => {
  const m = buildManifest(GOLDEN_FILES, GOLDEN_META);
  assert.equal(benchpackId(m), GOLDEN_BENCHPACK_ID);
});

test("golden: well-known sha256 vectors (sanity on the hash primitive)", () => {
  assert.equal(
    sha256Hex(""),
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  );
  assert.equal(
    sha256Hex("abc"),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
  // hashFile counts BYTES not chars (multibyte).
  assert.equal(hashFile("é").bytes, 2);
});

test("golden: canonicalization sorts object keys but preserves array order", () => {
  // A manifest rebuilt with a DIFFERENT field insertion order canonicalizes
  // identically (object keys are sorted).
  const m = buildManifest(GOLDEN_FILES, GOLDEN_META);
  const reordered = {
    version: m.version,
    toolchain: m.toolchain,
    payloadRoot: m.payloadRoot,
    files: m.files,
    declaredTouchedPaths: m.declaredTouchedPaths,
    baseContractHash: m.baseContractHash,
    packetId: m.packetId,
  };
  assert.equal(canonicalize(reordered), GOLDEN_CANONICAL);
});
