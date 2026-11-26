import { isDeepStrictEqual } from "node:util";
import { HOSTS, type HostFormat, type HostId } from "./hosts.ts";
import type { HostPaths } from "./paths.ts";
import { createJsonMcpCodec, type ConfigImage } from "./json.ts";
import { SETUP_CONFIG_BYTES, setTomlPath } from "./toml.ts";
import { publishImage, readImage, sameImage, withConfigLock } from "./fs-safe.ts";
import { digest, imageDigest, readReceipt, receiptPath, writeReceipt, type Receipt, type ReceiptTarget } from "./receipt.ts";

export interface EntryTarget {
  host: HostId;
  paths: HostPaths;
  name: string;
}

export interface PlanEntryOptions extends EntryTarget {
  entry: Readonly<Record<string, unknown>>;
}

type Change = "add" | "replace" | "unchanged";
type PlannedEntry = ReceiptTarget & {
  change: Change;
  entry: Readonly<Record<string, unknown>>;
  before: ConfigImage;
  after: ConfigImage;
  intent: string;
};
export type EntryPlan = PlannedEntry | { change: "refused"; reason: string };

export interface EntryResult {
  change: Change | "restored" | "removed";
  file: string;
  receipt: string;
}

const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const message = (error: unknown): string => error instanceof Error ? error.message : String(error);

function target(options: EntryTarget): ReceiptTarget {
  const { host, paths, name } = options;
  const files = paths.paths[host];
  if (!Object.hasOwn(HOSTS, host) || files?.length !== 1 || !files[0]) {
    throw new Error(`${host}: select exactly one supported configuration path before planning or undoing an entry`);
  }
  if (!name || /[\p{Cc}\p{Cf}]/u.test(name) || Buffer.byteLength(name) > 256) {
    throw new Error(`${files[0]}: provide a nonempty entry name of up to 256 bytes without control characters`);
  }
  return { host, file: files[0], name };
}

function configCodec({ host, file, name }: ReceiptTarget) {
  const format: HostFormat = HOSTS[host].format;
  if (format.kind === "json") {
    return createJsonMcpCodec({
      canonicalKey: format.key, aliases: format.aliases, entryName: name, label: file,
    });
  }
  const path = [...format.table, name];
  const text = (image: ConfigImage) => image.bytes === null ? "" : decoder.decode(Buffer.from(image.bytes, "base64"));
  function read(image: ConfigImage): unknown {
    let value: unknown = Bun.TOML.parse(text(image));
    for (const part of path) {
      if (!record(value)) throw new Error("expected an unambiguous TOML table");
      if (!Object.hasOwn(value, part)) return undefined;
      value = value[part];
    }
    return value;
  }
  function put(image: ConfigImage, value: unknown): ConfigImage {
    const input = text(image);
    const output = setTomlPath(input, path, value, { refuseInlineParent: true });
    return output === input ? image : { bytes: Buffer.from(output).toString("base64"), mode: image.mode };
  }
  function restore(before: ConfigImage, _after: ConfigImage, current: ConfigImage): ConfigImage {
    return put(current, read(before));
  }
  return { read, put, restore };
}

function editConfig<T>(file: string, work: () => T): T {
  try {
    return work();
  } catch (error) {
    throw new Error(`${file}: ${message(error)}; inspect the configuration syntax and the managed entry before retrying`, { cause: error });
  }
}

function makePlan(selection: ReceiptTarget, requested: PlanEntryOptions["entry"], before: ConfigImage): PlannedEntry {
  return editConfig(selection.file, () => {
    const encoded = JSON.stringify(requested);
    if (encoded === undefined || Buffer.byteLength(encoded) > SETUP_CONFIG_BYTES) throw new Error("invalid or oversized entry");
    const entry: unknown = JSON.parse(encoded);
    if (!record(entry) || !isDeepStrictEqual(entry, requested)) throw new Error("provide a plain JSON-compatible entry object");
    const codec = configCodec(selection);
    const current = codec.read(before);
    const after = codec.put(before, entry);
    if (!isDeepStrictEqual(codec.read(after), entry)) throw new Error("codec did not produce the requested entry");
    const intent = digest([selection.host, selection.file, selection.name, entry]);
    return { ...selection, entry, change: sameImage(before, after) ? "unchanged" : current === undefined ? "add" : "replace",
      before, after, intent };
  });
}

export function planEntry(options: PlanEntryOptions): EntryPlan {
  try {
    const selection = target(options);
    return makePlan(selection, options.entry, readImage(selection.file, SETUP_CONFIG_BYTES));
  } catch (error) {
    return { change: "refused", reason: message(error) };
  }
}

function result(selection: ReceiptTarget, receipt: string, change: EntryResult["change"]): EntryResult {
  return { file: selection.file, receipt, change };
}

function restoreOwned(receipt: Receipt, current: ConfigImage): ConfigImage {
  return editConfig(receipt.file, () => {
    const codec = configCodec(receipt);
    if (!isDeepStrictEqual(codec.read(current), codec.read(receipt.after))) {
      throw new Error("managed entry changed since installation; restore the installed entry or resolve the conflict manually");
    }
    const restored = current.bytes === receipt.after.bytes
      ? receipt.before
      : codec.restore(receipt.before, receipt.after, current);
    return { bytes: restored.bytes, mode: current.mode };
  });
}

function assertPending(receipt: Receipt, current: ConfigImage): "start" | "result" {
  const active = receipt.pending!;
  const actual = imageDigest(current);
  if (actual === active.result) return "result";
  if (actual === active.start) return "start";
  throw new Error(`${receipt.file}: configuration changed during an interrupted ${active.kind}; inspect the configuration and receipt before retrying`);
}

export function applyEntry(plan: EntryPlan, { receiptDir }: { receiptDir: string }): EntryResult {
  if (plan.change === "refused") throw new Error(plan.reason);
  if (!Object.hasOwn(HOSTS, plan.host)) throw new Error(`${plan.host}: select a supported host and replan`);
  const selection = { host: plan.host, file: plan.file, name: plan.name };
  const path = receiptPath(receiptDir, selection);
  return withConfigLock(plan.file, () => {
    const current = readImage(plan.file, SETUP_CONFIG_BYTES);
    const { image, receipt } = readReceipt(path, selection);
    const next = makePlan(selection, plan.entry, current);
    if (next.intent !== plan.intent) throw new Error(`${plan.file}: plan intent changed; generate a fresh plan`);
    if (receipt?.pending) {
      if (receipt.pending.kind !== "apply" || receipt.intent !== plan.intent) {
        throw new Error(`${path}: another write is pending; retry the interrupted operation first`);
      }
      if (assertPending(receipt, current) === "start") {
        if (!sameImage(next.after, receipt.after)) throw new Error(`${path}: pending image changed; inspect the receipt before retrying`);
        publishImage(plan.file, SETUP_CONFIG_BYTES, current, next.after);
      }
      const { pending, ...completed } = receipt;
      writeReceipt(path, image, completed);
      return result(selection, path, next.change);
    }
    if (receipt && receipt.intent === plan.intent && next.change === "unchanged") {
      return result(selection, path, "unchanged");
    }
    if (!sameImage(current, plan.before) || !sameImage(next.after, plan.after)) {
      throw new Error(`${plan.file}: configuration changed since preview; generate a fresh plan`);
    }
    // Keep the original ownership baseline, refreshed with unrelated edits made since the last apply.
    const baseline = receipt ? restoreOwned(receipt, current) : current;
    if (next.change === "unchanged") return result(selection, path, "unchanged");
    const completed: Receipt = { version: 1, ...selection, intent: next.intent, before: baseline, after: next.after };
    const pending: Receipt = { ...completed, pending: { kind: "apply", start: imageDigest(current), result: imageDigest(next.after) } };
    const journal = writeReceipt(path, image, pending);
    publishImage(plan.file, SETUP_CONFIG_BYTES, current, next.after);
    writeReceipt(path, journal, completed);
    return result(selection, path, next.change);
  });
}

export function undoEntry(options: EntryTarget & { receiptDir: string }): EntryResult {
  const selection = target(options);
  const { file } = selection;
  const path = receiptPath(options.receiptDir, selection);
  // An absent receipt needs no lock or directory creation.
  if (!readReceipt(path, selection).receipt) return result(selection, path, "unchanged");
  return withConfigLock(file, () => {
    const { image, receipt } = readReceipt(path, selection);
    if (!receipt) return result(selection, path, "unchanged");
    const current = readImage(file, SETUP_CONFIG_BYTES);
    if (receipt.pending?.kind === "apply") {
      throw new Error(`${path}: an apply is pending; retry the interrupted apply before undoing`);
    }
    const change = editConfig(file, () => configCodec(selection).read(receipt.before) === undefined ? "removed" : "restored");
    if (receipt.pending && assertPending(receipt, current) === "result") {
      writeReceipt(path, image);
      return result(selection, path, change);
    }
    const restored = restoreOwned(receipt, current);
    const pending: Receipt = { ...receipt, pending: { kind: "undo", start: imageDigest(current), result: imageDigest(restored) } };
    if (receipt.pending && receipt.pending.result !== pending.pending!.result) {
      throw new Error(`${path}: pending undo changed; inspect the receipt before retrying`);
    }
    const journal = receipt.pending ? image : writeReceipt(path, image, pending);
    publishImage(file, SETUP_CONFIG_BYTES, current, restored);
    writeReceipt(path, journal);
    return result(selection, path, change);
  });
}
