// `bench forge` contributor-side commands — pull a contract-pack, pack + SIGN a
// `.benchpack`, deliver it to Bench, and poll delivery status.
//
//   bench forge pull <packetId>          → fetch the frozen contract-pack to disk
//   bench forge pack <dir> --key <pem>   → build + ed25519-sign a .benchpack envelope
//   bench forge deliver <packetId> <bp>  → init → upload → finalize the delivery
//   bench forge contrib-status <p> <c>   → poll the sanitized delivery status
//
// The signing/packing MUST be byte-compatible with the server's verifyBenchpack
// (#2144) — it is built on the vendored `src/lib/benchpack/*` lib, which is
// algorithm-identical to `apps/web/src/lib/forge/benchpack`.
//
// Server contract (all on ${apiBase} with the shared x-api-key +
// x-expected-instance-id headers from forge.mjs):
//   GET  /v1/forge/packets/agent/{id}/contract-pack
//   POST /v1/forge/packets/agent/{id}/contributions/init
//   PUT  {uploadUrl}                       (GCS signed URL, application/json)
//   POST /v1/forge/packets/agent/{id}/contributions/finalize
//   GET  /v1/forge/packets/agent/{id}/contributions/status?contributionId=
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { c } from "../lib/format.mjs";
import { requireForgeAuth, forgeFetch } from "./forge.mjs";
import {
  buildManifest,
  benchpackId,
  canonicalizeToBytes,
  signManifest,
  sha256Hex,
} from "../lib/benchpack/index.mjs";

const CONTRACT_FILE = ".forge-contract.json";
// Names a `bench forge pull` writes that are scaffold, not contributor payload —
// they must never ride into the `.benchpack`.
const SCAFFOLD_NAMES = new Set([
  CONTRACT_FILE,
  ".forgeignore",
  "interfaces",
  "fixtures",
  "tests",
  "README.md",
]);

// ─── pull ────────────────────────────────────────────────────────────────────

export async function forgePull(positionals, flags) {
  const packetId = positionals[0];
  if (!packetId) {
    throw new Error("pull requires a packetId (see `bench forge --help`)");
  }
  const auth = requireForgeAuth();
  const pack = await forgeFetch(
    auth,
    "GET",
    `/v1/forge/packets/agent/${encodeURIComponent(packetId)}/contract-pack`,
  );
  if (flags.json) {
    process.stdout.write(JSON.stringify(pack, null, 2) + "\n");
    return 0;
  }

  const outDir = strFlag(flags.out) || path.resolve(`forge-${packetId}`);
  const dir = path.resolve(outDir);
  mkdirSync(dir, { recursive: true });

  const interfaces = Array.isArray(pack.interfaces) ? pack.interfaces : [];
  const fixtures = Array.isArray(pack.fixtures) ? pack.fixtures : [];
  const acceptanceTests = Array.isArray(pack.acceptanceTests)
    ? pack.acceptanceTests
    : [];

  // interfaces/*.d.ts (the body-stripped .d.ts surface).
  for (const iface of interfaces) {
    writeScaffold(dir, "interfaces", iface.path, iface.dts ?? "");
  }
  // fixtures/* (synthetic inputs).
  for (const fx of fixtures) {
    writeScaffold(dir, "fixtures", fx.path, fx.content ?? "");
  }
  // tests/* (black-box acceptance tests).
  for (const t of acceptanceTests) {
    writeScaffold(dir, "tests", t.path, t.content ?? "");
  }
  // README.md (the spec body).
  writeFileSync(path.join(dir, "README.md"), String(pack.readme ?? ""), "utf8");

  // The contract anchor — `bench forge pack` reads this for packetId +
  // baseContractHash (the pack's contentHash) + the declared surfaces.
  const declaredInterfaces = interfaces.map((i) => i.path).filter(Boolean);
  const declaredFixtures = fixtures.map((f) => f.path).filter(Boolean);
  const declaredTests = acceptanceTests.map((t) => t.path).filter(Boolean);
  const contract = {
    packetId: String(pack.packetId ?? packetId),
    version: pack.version,
    // The pack's contentHash IS the manifest's baseContractHash — finalize
    // asserts manifest.baseContractHash === the dispatch-frozen contract hash.
    contentHash: String(pack.contentHash ?? ""),
    baseContractHash: String(pack.baseContractHash ?? ""),
    ipClass: pack.ipClass,
    declaredInterfaces,
    declaredFixtures,
    declaredAcceptanceTests: declaredTests,
    pulledAt: new Date().toISOString(),
  };
  writeFileSync(
    path.join(dir, CONTRACT_FILE),
    JSON.stringify(contract, null, 2) + "\n",
    "utf8",
  );

  process.stdout.write(
    `${c.green("✓")} Contract-pack pulled\n` +
      `  packetId     ${c.bold(contract.packetId)}\n` +
      `  version      ${contract.version ?? ""}\n` +
      `  ipClass      ${contract.ipClass ?? ""}\n` +
      `  contentHash  ${truncateHash(contract.contentHash)}\n` +
      `  interfaces   ${interfaces.length}  fixtures ${fixtures.length}  tests ${acceptanceTests.length}\n` +
      `  → ${dir}\n` +
      c.dim(
        `\n  Build your implementation under this dir, then:\n` +
          `  bench forge pack ${shellQuote(dir)} --key <ed25519-private.pem>\n`,
      ),
  );
  return 0;
}

// ─── pack ────────────────────────────────────────────────────────────────────

export async function forgePack(positionals, flags) {
  const dirArg = positionals[0];
  if (!dirArg) {
    throw new Error("pack requires a <dir> (the pulled contract dir)");
  }
  const dir = path.resolve(dirArg);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    throw new Error(`pack: "${dirArg}" is not a directory`);
  }
  const keyPath = strFlag(flags.key);
  if (!keyPath) {
    throw new Error("pack requires --key <ed25519-private-pem-path>");
  }
  let privateKeyPem;
  try {
    privateKeyPem = readFileSync(path.resolve(keyPath), "utf8");
  } catch (err) {
    throw new Error(`pack: cannot read --key "${keyPath}" (${err?.message ?? err})`);
  }

  // Read the contract anchor written by `pull`.
  let contract;
  try {
    contract = JSON.parse(readFileSync(path.join(dir, CONTRACT_FILE), "utf8"));
  } catch {
    throw new Error(
      `pack: no ${CONTRACT_FILE} in "${dirArg}" — run \`bench forge pull <packetId> --out ${shellQuote(dirArg)}\` first`,
    );
  }
  const packetId = String(contract.packetId ?? "").trim();
  // The manifest's baseContractHash MUST be the pulled pack's contentHash — the
  // server's finalize binds manifest.baseContractHash === the dispatch-frozen
  // contract hash, which IS the pack contentHash served on pull.
  const baseContractHash = String(contract.contentHash ?? "").trim();
  if (!packetId) {
    throw new Error(`pack: ${CONTRACT_FILE} is missing "packetId"`);
  }
  if (!baseContractHash) {
    throw new Error(`pack: ${CONTRACT_FILE} is missing "contentHash"`);
  }

  // Collect the contributor's built files — everything under <dir> EXCEPT the
  // scaffold (the pulled contract surface) and anything matched by .forgeignore.
  const ignore = loadForgeIgnore(dir);
  const collected = collectFiles(dir, ignore);
  if (collected.length === 0) {
    throw new Error(
      `pack: no contributor files found under "${dirArg}" (everything was scaffold or ignored — did you add your implementation?)`,
    );
  }

  // Build the file-contents map keyed by repo-relative POSIX path.
  const fileContents = {};
  for (const rel of collected) {
    fileContents[rel] = readFileSync(path.join(dir, rel));
  }
  const declaredTouchedPaths = Object.keys(fileContents).sort();

  const manifest = buildManifest(fileContents, {
    packetId,
    baseContractHash,
    declaredTouchedPaths,
    ...(strFlag(flags.toolchain) ? { toolchain: strFlag(flags.toolchain) } : {}),
    ...(strFlag(flags.deps) ? { deps: strFlag(flags.deps) } : {}),
  });

  // Sign the JCS-CANONICAL manifest bytes (NOT the on-disk JSON) — the server
  // recomputes the canonical bytes and checks the signature over those.
  const canonicalBytes = canonicalizeToBytes(manifest);
  const signature = signManifest(canonicalBytes, privateKeyPem);

  // The wire envelope: { manifest, files: {path:{content}}, signature }. Files
  // are utf8 strings (the server reads `.content` as utf8/raw and re-hashes).
  const envFiles = {};
  for (const rel of declaredTouchedPaths) {
    envFiles[rel] = { content: fileContents[rel].toString("utf8") };
  }
  const envelope = { manifest, files: envFiles, signature };
  const envelopeJson = JSON.stringify(envelope);
  const envelopeSha = sha256Hex(envelopeJson);
  const bpId = benchpackId(manifest);

  const outFile = strFlag(flags.out) || `${dir}.benchpack.json`;
  const outPath = path.resolve(outFile);
  writeFileSync(outPath, envelopeJson, "utf8");

  if (flags.json) {
    process.stdout.write(
      JSON.stringify(
        {
          benchpackId: bpId,
          envelopeSha256: envelopeSha,
          packetId,
          baseContractHash,
          payloadRoot: manifest.payloadRoot,
          fileCount: declaredTouchedPaths.length,
          out: outPath,
        },
        null,
        2,
      ) + "\n",
    );
    return 0;
  }

  process.stdout.write(
    `${c.green("✓")} .benchpack built + signed\n` +
      `  benchpackId    ${c.bold(bpId)}\n` +
      `  sha256(envelope) ${envelopeSha}\n` +
      `  payloadRoot    ${truncateHash(manifest.payloadRoot)}\n` +
      `  files          ${declaredTouchedPaths.length}\n` +
      `  packetId       ${packetId}\n` +
      `  → ${outPath}\n` +
      c.dim(
        `\n  Deliver it:\n  bench forge deliver ${packetId} ${shellQuote(outPath)}\n`,
      ),
  );
  return 0;
}

// ─── deliver ─────────────────────────────────────────────────────────────────

export async function forgeDeliver(positionals, flags) {
  const [packetId, benchpackPath] = positionals;
  if (!packetId || !benchpackPath) {
    throw new Error("deliver requires <packetId> <benchpack.json>");
  }
  let envelopeJson;
  try {
    envelopeJson = readFileSync(path.resolve(benchpackPath), "utf8");
  } catch (err) {
    throw new Error(`deliver: cannot read "${benchpackPath}" (${err?.message ?? err})`);
  }
  // The declared hash + the bytes uploaded MUST be sha256 of the EXACT envelope
  // bytes — finalize recomputes sha256(envelope) and rejects a mismatch before
  // any verify. We upload the file bytes verbatim.
  const envelopeBuf = Buffer.from(envelopeJson, "utf8");
  const declaredEnvelopeSha256 = createHash("sha256")
    .update(envelopeBuf)
    .digest("hex");
  const idempotencyKey = strFlag(flags["idempotency-key"]) || declaredEnvelopeSha256;

  const auth = requireForgeAuth();
  const base = `/v1/forge/packets/agent/${encodeURIComponent(packetId)}/contributions`;

  // 1. init — declare the delivery, get a GCS signed write URL.
  const init = await forgeFetch(auth, "POST", `${base}/init`, {
    body: { idempotencyKey, declaredEnvelopeSha256 },
  });
  const contributionId = init.contributionId;
  const uploadUrl = init.uploadUrl;
  if (!contributionId || !uploadUrl) {
    throw new Error(
      `deliver: init did not return an upload URL (server said ${JSON.stringify(init)})`,
    );
  }

  // 2. upload — PUT the envelope bytes to the GCS signed URL. The URL was minted
  //    with contentType application/json + a 0..25MiB content-length-range; both
  //    headers MUST be echoed or GCS rejects the signature.
  await putEnvelope(uploadUrl, envelopeBuf);

  // 3. finalize — server downloads + re-hashes + verifies against the pinned key.
  const status = await forgeFetch(auth, "POST", `${base}/finalize`, {
    body: { contributionId },
  });

  if (flags.json) {
    process.stdout.write(
      JSON.stringify({ contributionId, ...status }, null, 2) + "\n",
    );
    return 0;
  }
  printDeliveryStatus(status, { contributionId, packetId });
  // A rejected/unverified delivery is a non-zero exit so scripts can branch.
  return deliveryFailed(status) ? 1 : 0;
}

// ─── contrib-status ──────────────────────────────────────────────────────────

export async function forgeContribStatus(positionals, flags) {
  const [packetId, contributionId] = positionals;
  if (!packetId || !contributionId) {
    throw new Error("contrib-status requires <packetId> <contributionId>");
  }
  const auth = requireForgeAuth();
  const status = await forgeFetch(
    auth,
    "GET",
    `/v1/forge/packets/agent/${encodeURIComponent(packetId)}/contributions/status`,
    { query: { contributionId } },
  );
  if (flags.json) {
    process.stdout.write(JSON.stringify(status, null, 2) + "\n");
    return 0;
  }
  printDeliveryStatus(status, { contributionId, packetId });
  return 0;
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function strFlag(v) {
  return typeof v === "string" ? v.trim() : "";
}

/**
 * PUT the envelope to the GCS signed URL. We echo the exact extension headers
 * the signed URL was minted with (content-type + the 0..25MiB length range);
 * GCS verifies them against the signature and 403s on a mismatch.
 */
async function putEnvelope(uploadUrl, envelopeBuf) {
  let res;
  try {
    res = await fetch(uploadUrl, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        "x-goog-content-length-range": `0,${25 * 1024 * 1024}`,
      },
      body: envelopeBuf,
    });
  } catch (err) {
    throw new Error(
      `deliver: upload failed to reach storage (${err?.cause?.code ?? err?.message ?? err})`,
    );
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `deliver: storage rejected the upload (${res.status}${text ? `: ${truncate(text.trim(), 200)}` : ""})`,
    );
  }
}

function deliveryFailed(status) {
  if (!status || typeof status !== "object") return true;
  if (status.deliveryStatus === "rejected") return true;
  if (status.signatureVerified === false && status.deliveryStatus !== "awaiting-upload") {
    return true;
  }
  return false;
}

function printDeliveryStatus(status, { contributionId, packetId }) {
  const s = status ?? {};
  const verified =
    s.signatureVerified === true
      ? c.green("verified")
      : s.signatureVerified === false
        ? c.red("not verified")
        : c.dim("n/a");
  const delivery = deliveryColor(s.deliveryStatus);
  process.stdout.write(
    `${deliveryFailed(s) ? c.red("✗") : c.green("✓")} Delivery ${delivery}\n` +
      `  packetId        ${packetId ?? ""}\n` +
      `  contributionId  ${contributionId ?? ""}\n` +
      `  lifecycle       ${s.lifecycleState ?? ""}\n` +
      `  signature       ${verified}\n`,
  );
  const findings = Array.isArray(s.findings) ? s.findings : [];
  if (findings.length) {
    process.stdout.write("\n" + c.yellow("Findings:") + "\n");
    for (const f of findings) process.stdout.write(`  - ${f}\n`);
  }
  if (s.code) {
    process.stdout.write(c.dim(`  code            ${s.code}\n`));
  }
}

function deliveryColor(ds) {
  switch (ds) {
    case "finalized":
      return c.green(ds);
    case "rejected":
      return c.red(ds);
    case "awaiting-upload":
      return c.yellow(ds);
    default:
      return ds ?? "";
  }
}

/** Read `.forgeignore` (gitignore-lite: blank/`#` lines skipped). */
function loadForgeIgnore(dir) {
  const p = path.join(dir, ".forgeignore");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
}

/**
 * Walk `dir` and return repo-relative POSIX paths of every contributor file —
 * skipping the pull scaffold (CONTRACT_FILE, interfaces/, fixtures/, tests/,
 * README.md, .forgeignore) and anything a .forgeignore pattern matches. Also
 * always skips dotfiles/dirs and node_modules so a build dir never leaks.
 */
function collectFiles(dir, ignorePatterns) {
  const out = [];
  walk(dir, "");
  return out.sort();

  function walk(absDir, relPrefix) {
    let entries;
    try {
      entries = readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const name = ent.name;
      const rel = relPrefix ? `${relPrefix}/${name}` : name;
      // Top-level scaffold is never payload.
      if (relPrefix === "" && SCAFFOLD_NAMES.has(name)) continue;
      // Never ship dotfiles/dirs (.git, .forge-contract.json caught above, etc)
      // or a node_modules build dir.
      if (name.startsWith(".")) continue;
      if (name === "node_modules") continue;
      if (matchesIgnore(rel, ignorePatterns)) continue;
      if (ent.isDirectory()) {
        walk(path.join(absDir, name), rel);
      } else if (ent.isFile()) {
        out.push(rel);
      }
    }
  }
}

/**
 * Minimal `.forgeignore` matcher: exact path, a directory prefix (`dir/`), or a
 * single-`*` basename glob (`*.log`). Conservative by design — it is a
 * convenience skip, NOT a security boundary (the server re-checks paths).
 */
function matchesIgnore(rel, patterns) {
  const base = rel.split("/").pop();
  for (const raw of patterns) {
    const pat = raw.replace(/\/+$/, "");
    if (rel === pat) return true;
    if (rel === raw) return true;
    if (rel.startsWith(`${pat}/`)) return true;
    if (pat.startsWith("*.")) {
      const ext = pat.slice(1); // ".log"
      if (base.endsWith(ext)) return true;
    }
  }
  return false;
}

/** Write a scaffold file under <dir>/<subdir>/<relPath>, creating parent dirs. */
function writeScaffold(dir, subdir, relPath, content) {
  const safeRel = String(relPath ?? "").replace(/^\/+/, "");
  // Flatten a bare basename if no subpath was given; never escape <dir>.
  const target = path.join(dir, subdir, safeRel);
  const resolved = path.resolve(target);
  const root = path.resolve(dir);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`pull: refusing to write outside the out dir: ${relPath}`);
  }
  mkdirSync(path.dirname(resolved), { recursive: true });
  writeFileSync(resolved, String(content ?? ""), "utf8");
}

function truncateHash(h) {
  const s = String(h ?? "");
  return s.length > 16 ? `${s.slice(0, 16)}…` : s;
}

function truncate(s, n) {
  if (!s) return "";
  return s.length > n ? s.slice(0, Math.max(0, n - 1)) + "…" : s;
}

function shellQuote(s) {
  return /[^A-Za-z0-9_./-]/.test(s) ? `'${s.replace(/'/g, "'\\''")}'` : s;
}
