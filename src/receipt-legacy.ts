import { createHash } from "node:crypto";
import { join } from "node:path";
import type { ConfigImage } from "./json.ts";
import { isConfigImage, readReceiptValue, type ReceiptTarget } from "./receipt.ts";
import { SETUP_CONFIG_BYTES } from "./toml.ts";
import { EntryRefusal } from "./refusal.ts";

export type LegacyReceipt =
  | { kind: "agent-mem"; path: string; before: ConfigImage; after: ConfigImage; intent: string }
  | { kind: "entry"; path: string; existed: boolean; keyExisted: boolean; prior: unknown; priorToml?: string; installed: unknown };

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function invalid(path: string, reason: string): never {
  throw new EntryRefusal("invalid-receipt", `${path}: ${reason}; inspect the receipt or use the consumer release that wrote it`, { file: path });
}

function memoryReceipt(path: string, target: ReceiptTarget, candidates: readonly string[], raw: unknown): LegacyReceipt {
  if (!record(raw) || (raw.version !== 1 && raw.version !== 2) || raw.target !== target.host
    || typeof raw.intent !== "string" || !/^[a-f0-9]{64}$/.test(raw.intent) || !Array.isArray(raw.changes)) {
    return invalid(path, "invalid or foreign agent-mem receipt");
  }
  if (raw.phase !== "applied") return invalid(path, "agent-mem setup is incomplete");
  const change: unknown = raw.changes[0];
  if (!record(change) || change.key !== `${target.host}:0` || typeof change.path !== "string"
    || !candidates.includes(change.path) || !isConfigImage(change.before) || !isConfigImage(change.after)
    || change.after.bytes === null || (change.start !== undefined && !isConfigImage(change.start))) {
    return invalid(path, "agent-mem MCP image does not match the selected configuration");
  }
  return { kind: "agent-mem", path, before: change.before, after: change.after, intent: raw.intent };
}

function entryReceipt(path: string, target: ReceiptTarget, file: string, raw: unknown): LegacyReceipt {
  const vault = target.name === "vmem";
  if (!record(raw) || (vault ? raw.version !== 1 : raw.v !== 1) || raw.target !== target.host || raw.file !== file
    || typeof raw.existed !== "boolean" || (raw.keyExisted !== undefined && typeof raw.keyExisted !== "boolean")
    || !record(raw.installed) || typeof raw.installed.command !== "string" || !Array.isArray(raw.installed.args)
    || !raw.installed.args.every((arg: unknown) => typeof arg === "string")) {
    return invalid(path, "invalid or foreign setup receipt");
  }
  if (!vault && (typeof raw.keyExisted !== "boolean" || typeof raw.priorPresent !== "boolean"
    || (raw.priorPresent && !Object.hasOwn(raw, "prior")))) return invalid(path, "invalid agent-research prior entry");
  const prior = vault ? raw.prior ?? undefined : raw.priorPresent ? raw.prior : undefined;
  let priorToml: string | undefined;
  if (raw.priorToml !== undefined) {
    if (vault && Array.isArray(raw.priorToml) && raw.priorToml.every((line: unknown) => typeof line === "string")) {
      priorToml = raw.priorToml.join("\n") + "\n";
    } else if (!vault && typeof raw.priorToml === "string") {
      priorToml = raw.priorToml;
    } else return invalid(path, "invalid prior TOML block");
    if (target.host !== "codex" || prior === undefined || Buffer.byteLength(priorToml) > SETUP_CONFIG_BYTES) {
      return invalid(path, "unexpected or oversized prior TOML block");
    }
  }
  return { kind: "entry", path, existed: raw.existed, keyExisted: raw.keyExisted === true, prior, priorToml, installed: raw.installed };
}

export function readLegacyReceipt(directory: string, target: ReceiptTarget, legacyPaths: readonly string[] = []): LegacyReceipt | undefined {
  const candidates = [...new Set([target.file, ...legacyPaths])];
  if (target.name === "amem") {
    const path = join(directory, `${target.host}.json`);
    const { image, value } = readReceiptValue(path, 12 * SETUP_CONFIG_BYTES);
    return image.bytes === null ? undefined : memoryReceipt(path, target, candidates, value);
  }
  if (target.name !== "vmem" && target.name !== "ares") return undefined;

  const limit = target.name === "vmem" ? 4 * 1024 * 1024 : 8 * 1024 * 1024;
  let found: LegacyReceipt | undefined;
  for (const file of candidates) {
    const hash = createHash("sha256").update(file).digest("hex").slice(0, 16);
    const path = join(directory, `${target.host}-${hash}.json`);
    const { image, value } = readReceiptValue(path, limit);
    if (image.bytes === null) continue;
    if (found) return invalid(path, `multiple setup receipts match ${target.file}`);
    found = entryReceipt(path, target, file, value);
  }
  return found;
}
