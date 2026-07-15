import { randomUUID } from "node:crypto";
import { chmod, link, lstat, mkdir, open, readFile, unlink } from "node:fs/promises";
import { dirname, isAbsolute, resolve, sep } from "node:path";

import { requestDigest } from "./receipts.js";
import { UcpDeniedError } from "./types.js";

export const SEAT_PACKET_SCHEMA_VERSION = "excalibur.seat-packet.v1" as const;

export type SeatPacket = {
  schemaVersion: typeof SEAT_PACKET_SCHEMA_VERSION;
  packetId: string;
  goal: string;
  repoPaths: string[];
  nonGoals: string[];
  proof: string[];
  maxFiles: number;
  effects: "none";
  credentials: "forbidden";
  expiresAt: string;
  packetDigest: string;
};

const MAX_PACKET_BYTES = 128 * 1024;
const PROTECTED_ACTIVE_INTENT = /(?:\bgit\s+push\b|\bgh\s+pr\s+(?:create|ready|merge)\b|\b(?:ssh|scp|sftp)\b|\b(?:deploy|merge|ready\s+(?:the\s+)?pr|send\s+(?:an?\s+)?(?:email|mail|message)|invite|publish\s+(?:to\s+)?production|force[- ]?push|access\s+(?:a\s+)?secret|retrieve\s+(?:a\s+)?credential)\b)/i;
const SECRET_SHAPE = /(?:-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bgh[opsu]_[A-Za-z0-9_]{20,}\b|\bAKIA[0-9A-Z]{16}\b|\bBearer\s+[A-Za-z0-9._~-]{20,})/;
const SENSITIVE_PATH_SEGMENT = /^(?:\.ssh|\.gnupg|\.aws|\.azure|\.kube|\.1password|keychains?)$/i;

function boundedText(value: unknown, label: string, maximum = 4_000): string {
  if (typeof value !== "string") throw new UcpDeniedError("SEAT_PACKET_INVALID", `${label} must be text`);
  const text = value.trim();
  if (!text || text.length > maximum || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) {
    throw new UcpDeniedError("SEAT_PACKET_INVALID", `${label} is empty, oversized, or contains control characters`);
  }
  if (SECRET_SHAPE.test(text)) throw new UcpDeniedError("SEAT_PACKET_SECRET_DENIED", "Credential-shaped material is forbidden in seat packets");
  return text;
}

function textList(value: unknown, label: string, minimum: number, maximum: number): string[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    throw new UcpDeniedError("SEAT_PACKET_INVALID", `${label} must contain ${minimum}-${maximum} entries`);
  }
  return value.map((item, index) => boundedText(item, `${label}[${index}]`, 1_000));
}

function repoPaths(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 8) {
    throw new UcpDeniedError("SEAT_PACKET_INVALID", "repoPaths must contain 1-8 absolute paths");
  }
  const paths = value.map((item) => boundedText(item, "repo path", 1_024));
  if (paths.some((item) => !isAbsolute(item) || item.split(sep).includes(".."))) {
    throw new UcpDeniedError("SEAT_PACKET_PATH_DENIED", "Seat packet repo paths must be absolute and traversal-free");
  }
  if (paths.some((item) => item.split(sep).some((segment) => SENSITIVE_PATH_SEGMENT.test(segment)))) {
    throw new UcpDeniedError("SEAT_PACKET_PATH_DENIED", "Seat packet repo paths cannot name credential or key-store directories");
  }
  return [...new Set(paths.map((item) => resolve(item)))];
}

export function createSeatPacket(value: unknown, now = new Date()): SeatPacket {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new UcpDeniedError("SEAT_PACKET_INVALID", "Seat packet input must be an object");
  }
  const input = value as Record<string, unknown>;
  const allowed = new Set(["goal", "repoPaths", "nonGoals", "proof", "maxFiles", "expiresAt"]);
  const extra = Object.keys(input).filter((key) => !allowed.has(key));
  if (extra.length) throw new UcpDeniedError("SEAT_PACKET_FIELD_DENIED", "Seat packet contains unsupported fields");
  const goal = boundedText(input.goal, "goal");
  const proof = textList(input.proof, "proof", 1, 20);
  if (PROTECTED_ACTIVE_INTENT.test(goal) || proof.some((item) => PROTECTED_ACTIVE_INTENT.test(item))) {
    throw new UcpDeniedError("UNBOUNDED_ORCHESTRA_PACKET_DENIED", "Seat goal/proof requests a protected external effect");
  }
  const nonGoals = textList(input.nonGoals, "nonGoals", 1, 20);
  const maxFiles = Number(input.maxFiles);
  if (!Number.isInteger(maxFiles) || maxFiles < 1 || maxFiles > 50) {
    throw new UcpDeniedError("SEAT_PACKET_MAX_FILES_INVALID", "maxFiles must be an integer from 1 to 50");
  }
  const expiresAt = typeof input.expiresAt === "string"
    ? new Date(input.expiresAt)
    : new Date(now.getTime() + 4 * 60 * 60 * 1_000);
  if (!Number.isFinite(expiresAt.getTime()) || expiresAt <= now || expiresAt.getTime() - now.getTime() > 24 * 60 * 60 * 1_000) {
    throw new UcpDeniedError("SEAT_PACKET_EXPIRY_INVALID", "Seat packet expiry must be within the next 24 hours");
  }
  const unsigned = {
    schemaVersion: SEAT_PACKET_SCHEMA_VERSION,
    packetId: randomUUID(),
    goal,
    repoPaths: repoPaths(input.repoPaths),
    nonGoals,
    proof,
    maxFiles,
    effects: "none" as const,
    credentials: "forbidden" as const,
    expiresAt: expiresAt.toISOString(),
  };
  return { ...unsigned, packetDigest: requestDigest(unsigned) };
}

export function validateSeatPacket(value: unknown, now = new Date()): SeatPacket {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new UcpDeniedError("SEAT_PACKET_INVALID", "Frozen seat packet must be an object");
  }
  const packet = value as SeatPacket;
  const expectedKeys = [
    "schemaVersion", "packetId", "goal", "repoPaths", "nonGoals", "proof",
    "maxFiles", "effects", "credentials", "expiresAt", "packetDigest",
  ].sort();
  if (Object.keys(packet).sort().join("\n") !== expectedKeys.join("\n")
      || packet.schemaVersion !== SEAT_PACKET_SCHEMA_VERSION
      || !/^[0-9a-f-]{36}$/.test(packet.packetId)
      || packet.effects !== "none"
      || packet.credentials !== "forbidden") {
    throw new UcpDeniedError("SEAT_PACKET_INVALID", "Frozen seat packet schema is invalid");
  }
  const goal = boundedText(packet.goal, "goal");
  repoPaths(packet.repoPaths);
  textList(packet.nonGoals, "nonGoals", 1, 20);
  const proof = textList(packet.proof, "proof", 1, 20);
  if (PROTECTED_ACTIVE_INTENT.test(goal) || proof.some((item) => PROTECTED_ACTIVE_INTENT.test(item))) {
    throw new UcpDeniedError("UNBOUNDED_ORCHESTRA_PACKET_DENIED", "Frozen seat goal/proof requests a protected external effect");
  }
  if (!Number.isInteger(packet.maxFiles) || packet.maxFiles < 1 || packet.maxFiles > 50) {
    throw new UcpDeniedError("SEAT_PACKET_MAX_FILES_INVALID", "Frozen maxFiles is invalid");
  }
  const expiresAt = Date.parse(packet.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= now.getTime()) {
    throw new UcpDeniedError("SEAT_PACKET_EXPIRED", "Frozen seat packet has an invalid or expired expiry");
  }
  if (expiresAt - now.getTime() > 24 * 60 * 60 * 1_000) {
    throw new UcpDeniedError("SEAT_PACKET_EXPIRY_INVALID", "Frozen seat packet expiry exceeds the next 24 hours");
  }
  const { packetDigest, ...unsigned } = packet;
  if (packetDigest !== requestDigest(unsigned)) throw new UcpDeniedError("SEAT_PACKET_DIGEST_MISMATCH", "Frozen seat packet digest does not match");
  return packet;
}

export async function writeFrozenPacket(path: string, packet: SeatPacket): Promise<void> {
  if (!isAbsolute(path)) throw new UcpDeniedError("SEAT_PACKET_PATH_DENIED", "Frozen packet path must be absolute");
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const parent = await lstat(dirname(path));
  const uid = typeof process.getuid === "function" ? process.getuid() : parent.uid;
  if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== uid || (parent.mode & 0o077) !== 0) {
    throw new UcpDeniedError("SEAT_PACKET_PATH_DENIED", "Frozen packet storage must be an owner-private, non-symlinked directory");
  }
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(packet, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await link(temporary, path);
  } catch {
    throw new UcpDeniedError("SEAT_PACKET_OUTPUT_EXISTS", "Frozen packet output already exists; no file was replaced");
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
  await chmod(path, 0o600);
  const directory = await open(dirname(path), "r");
  try { await directory.sync(); } finally { await directory.close(); }
}

export async function readFrozenPacket(path: string): Promise<SeatPacket> {
  if (!isAbsolute(path)) throw new UcpDeniedError("SEAT_PACKET_PATH_DENIED", "Frozen packet path must be absolute");
  const info = await lstat(path).catch(() => null);
  const uid = typeof process.getuid === "function" ? process.getuid() : info?.uid;
  if (!info?.isFile() || info.isSymbolicLink() || info.uid !== uid || info.size > MAX_PACKET_BYTES || (info.mode & 0o077) !== 0) {
    throw new UcpDeniedError("SEAT_PACKET_FILE_UNSAFE", "Frozen packet must be a bounded owner-private file");
  }
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new UcpDeniedError("SEAT_PACKET_INVALID", "Frozen packet is not valid JSON");
  }
  return validateSeatPacket(value);
}
