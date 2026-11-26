import { createHash } from "node:crypto";
import { isAbsolute, join, resolve } from "node:path";
import { publishImage, readImage } from "./fs-safe.ts";
import type { HostId } from "./hosts.ts";
import type { ConfigImage } from "./json.ts";
import { SETUP_CONFIG_BYTES } from "./toml.ts";
import { EntryRefusal } from "./refusal.ts";

const BASE64_LIMIT = Math.ceil(SETUP_CONFIG_BYTES / 3) * 4;
// Two full configuration images plus metadata and pending-operation hashes.
const RECEIPT_BYTES = 2 * BASE64_LIMIT + 64 * 1024;
const hashPattern = /^[a-f0-9]{64}$/;
export const digest = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const imageDigest = (image: ConfigImage): string => digest([image.bytes, image.bytes === null ? null : image.mode]);

export interface ReceiptTarget {
  host: HostId;
  file: string;
  name: string;
}

export interface Receipt extends ReceiptTarget {
  version: 1;
  intent: string;
  before: ConfigImage;
  after: ConfigImage;
  pending?: { kind: "apply" | "undo"; start: string; result: string };
}

export function receiptPath(directory: string, target: ReceiptTarget): string {
  if (!isAbsolute(directory) || resolve(directory) !== directory) {
    throw new EntryRefusal("unsafe-path", `${directory}: supply an absolute receipt directory without redirects or parent segments`);
  }
  return join(directory, `entry-${digest([target.file, target.name])}.json`);
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const isDigest = (value: unknown): value is string => typeof value === "string" && hashPattern.test(value);

export function isConfigImage(value: unknown): value is ConfigImage {
  if (!isRecord(value) || typeof value.mode !== "number" || !Number.isInteger(value.mode)
    || value.mode < 0 || value.mode > 0o7777) return false;
  if (value.bytes === null) return true;
  if (typeof value.bytes !== "string" || value.bytes.length > BASE64_LIMIT) return false;
  const bytes = Buffer.from(value.bytes, "base64");
  return bytes.length <= SETUP_CONFIG_BYTES && bytes.toString("base64") === value.bytes;
}

export function readReceiptValue(path: string, limit: number): { image: ConfigImage; value?: unknown } {
  const image = readImage(path, limit);
  if (image.bytes === null) return { image };
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(image.bytes, "base64"));
    return { image, value: JSON.parse(text) };
  } catch (cause) {
    throw new EntryRefusal("invalid-receipt", `${path}: invalid receipt JSON; inspect or restore the original receipt before retrying`, { cause });
  }
}

export function readReceipt(path: string, target: ReceiptTarget): { image: ConfigImage; receipt?: Receipt } {
  const { image, value } = readReceiptValue(path, RECEIPT_BYTES);
  if (image.bytes === null) return { image };
  const refuse = (): never => {
    throw new EntryRefusal("invalid-receipt", `${path}: invalid or unsupported receipt; inspect or restore the original receipt before retrying`);
  };
  if (!isRecord(value) || value.version !== 1 || value.host !== target.host || value.file !== target.file
    || value.name !== target.name || !isDigest(value.intent) || !isConfigImage(value.before) || !isConfigImage(value.after)) return refuse();
  const pending = value.pending;
  if (pending !== undefined && (!isRecord(pending) || (pending.kind !== "apply" && pending.kind !== "undo")
    || !isDigest(pending.start) || !isDigest(pending.result)
    || pending.kind === "apply" && pending.result !== imageDigest(value.after))) return refuse();
  return { image, receipt: value as unknown as Receipt };
}

export function writeReceipt(path: string, expected: ConfigImage, receipt?: Receipt): ConfigImage {
  const bytes = receipt ? Buffer.from(JSON.stringify(receipt)).toString("base64") : null;
  const image = { bytes, mode: 0o600 };
  publishImage(path, RECEIPT_BYTES, expected, image);
  return image;
}
