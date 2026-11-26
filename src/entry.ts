import { lstatSync } from "node:fs";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { HOSTS, type HostFormat, type HostId } from "./hosts.ts";
import { openCodeRouteReason, type HostPaths, type ResolveHostPathsOptions } from "./paths.ts";
import { createJsonMcpCodec, type ConfigImage } from "./json.ts";
import { SETUP_CONFIG_BYTES, setTomlPath } from "./toml.ts";
import { publishImage, readImage, sameImage, withConfigLock } from "./fs-safe.ts";
import { digest, findPackageReceipt, imageDigest, readRecovery, writeReceipt, writeRecovery, type Receipt, type ReceiptTarget } from "./receipt.ts";
import { readLegacyReceipt, type LegacyReceipt } from "./receipt-legacy.ts";
import { asEntryRefusal, EntryRefusal, type RefusalCode } from "./refusal.ts";

export interface EntryTarget {
  host: HostId;
  paths: HostPaths;
  name: string;
}

export interface PlanEntryOptions extends EntryTarget {
  entry: Readonly<Record<string, unknown>> | null;
}

export interface ApplyEntryOptions {
  receiptDir: string;
  /** A fresh injected environment is required for OpenCode. */
  env?: ResolveHostPathsOptions["env"];
}

export const UNDO_NOOP_CODES = ["no-receipt", "entry-already-absent", "entry-already-restored"] as const;
export type UndoNoopCode = typeof UNDO_NOOP_CODES[number];

type Change = "add" | "replace" | "remove" | "unchanged";
type PlannedEntry = ReceiptTarget & {
  change: Change;
  entry: Readonly<Record<string, unknown>> | null;
  current: unknown;
  legacyPaths: readonly string[];
  before: ConfigImage;
  after: ConfigImage;
  intent: string;
  /** OpenCode routing-variable names observed at preview. Values are never kept. */
  opencodeRoutes?: readonly string[];
};
export type EntryPlan = PlannedEntry | { change: "refused"; code: RefusalCode; reason: string; file?: string };

export interface EntryResult {
  change: Change | "restored" | "removed";
  file: string;
  receipt: string;
  code?: UndoNoopCode;
  intent?: string;
  supersedes?: string;
  /** A retained consumer receipt that the caller manages. */
  legacy?: true;
}

const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const message = (error: unknown): string => error instanceof Error ? error.message : String(error);

function target(options: EntryTarget): ReceiptTarget {
  const { host, paths, name } = options;
  // OpenCode routing blocks writes but leaves the global path available for undo.
  const refusal = paths.refusals.find((item) => item.host === host && item.code !== "opencode-config-route");
  if (refusal) throw new EntryRefusal(refusal.code, refusal.reason, { file: refusal.file });
  const files = paths.paths[host];
  if (!Object.hasOwn(HOSTS, host) || files?.length !== 1 || !files[0]) {
    throw new EntryRefusal("invalid-target", `${host}: select exactly one supported configuration path before planning or undoing an entry`);
  }
  if (!name || /[\p{Cc}\p{Cf}]/u.test(name) || Buffer.byteLength(name) > 256) {
    throw new EntryRefusal("invalid-entry", `${files[0]}: provide a nonempty entry name of up to 256 bytes without control characters`, { file: files[0] });
  }
  return { host, file: files[0], name };
}

function configCodec({ host, file, name }: ReceiptTarget, legacy = false) {
  const format: HostFormat = HOSTS[host].format;
  if (format.kind === "json") {
    return createJsonMcpCodec({
      canonicalKey: format.key, aliases: format.aliases, entryName: name, label: file, preferCanonical: legacy && host === "jcode",
    });
  }
  const tablePath = format.table;
  const path = [...tablePath, name];
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
  function put(image: ConfigImage, value: unknown, options?: { keepEmpty?: boolean }): ConfigImage {
    const input = text(image);
    let output = setTomlPath(input, path, value, { refuseInlineParent: true });
    if (value === undefined && options?.keepEmpty === false) {
      const doc = Bun.TOML.parse(output) as Record<string, unknown>;
      const parent = doc[tablePath[0]!];
      if (record(parent) && !Object.keys(parent).length) output = setTomlPath(output, tablePath, undefined);
    }
    return output === input ? image : { bytes: Buffer.from(output).toString("base64"), mode: image.mode };
  }
  function restore(before: ConfigImage, _after: ConfigImage, current: ConfigImage, _options?: { ownedOnly?: boolean }): ConfigImage {
    const prior = Bun.TOML.parse(text(before)) as Record<string, unknown>;
    const restored = put(current, read(before), { keepEmpty: Object.hasOwn(prior, tablePath[0]!) });
    return before.bytes === null && text(restored).trim() === "" ? { bytes: null, mode: current.mode } : restored;
  }
  return { read, put, restore };
}

function editConfig<T>(file: string, work: () => T): T {
  try {
    return work();
  } catch (error) {
    const code = error instanceof EntryRefusal ? error.code : "invalid-configuration";
    throw new EntryRefusal(code, `${file}: ${message(error)}; inspect the configuration syntax and the managed entry before retrying`, { cause: error, file });
  }
}

function assertHostEdit(selection: ReceiptTarget, entry: PlanEntryOptions["entry"], opencodeRoutes: readonly string[] | undefined): void {
  const { host, file } = selection;
  if (host === "opencode") {
    const variable = opencodeRoutes?.[0];
    if (variable) throw new EntryRefusal("opencode-config-route", openCodeRouteReason(variable, file));
    for (const sibling of HOSTS.opencode.files[0].mergedFiles) {
      const other = join(dirname(file), sibling);
      if (lstatSync(other, { throwIfNoEntry: false })) {
        throw new EntryRefusal(
          "opencode-merged-config",
          `${other} is merged with ${file}; consolidate the configuration into opencode.json before applying`,
        );
      }
    }
  }
  if (host === "jcode" && entry !== null) {
    const args: readonly unknown[] = Array.isArray(entry.args) ? entry.args : [];
    const interpolates = (value: unknown) => typeof value === "string" && value.includes("${");
    if (interpolates(entry.command) || args.some(interpolates)) {
      throw new EntryRefusal("jcode-interpolation", `${file}: Jcode interpolates \${ in a command or argument; remove the placeholder before applying`);
    }
  }
}

function makePlan(
  selection: ReceiptTarget,
  requested: PlanEntryOptions["entry"],
  before: ConfigImage,
  opencodeRoutes?: readonly string[],
  legacyPaths: readonly string[] = [],
): PlannedEntry {
  assertHostEdit(selection, requested, opencodeRoutes);
  return editConfig(selection.file, () => {
    const encoded = JSON.stringify(requested);
    if (encoded === undefined) throw new EntryRefusal("invalid-entry", "provide a plain JSON-compatible entry object");
    if (Buffer.byteLength(encoded) > SETUP_CONFIG_BYTES) throw new EntryRefusal("size-limit", "reduce the entry to at most 8 MiB");
    const entry: unknown = JSON.parse(encoded);
    if ((entry !== null && !record(entry)) || !isDeepStrictEqual(entry, requested)) throw new EntryRefusal("invalid-entry", "provide a plain JSON-compatible entry object");
    const codec = configCodec(selection);
    const current = codec.read(before);
    const desired = entry === null ? undefined : entry;
    const after = entry === null && current === undefined ? before : codec.put(before, desired);
    if (!isDeepStrictEqual(codec.read(after), desired)) throw new EntryRefusal("invalid-entry", "codec did not produce the requested entry");
    const intent = digest([selection.host, selection.file, selection.name, entry]);
    return { ...selection, entry, change: sameImage(before, after) ? "unchanged" : entry === null ? "remove" : current === undefined ? "add" : "replace",
      before, after, current, intent, legacyPaths, ...(opencodeRoutes ? { opencodeRoutes } : {}) };
  });
}

export function planEntry(options: PlanEntryOptions): EntryPlan {
  let file: string | undefined;
  try {
    const selection = target(options);
    file = selection.file;
    const routes = selection.host === "opencode"
      ? options.paths.refusals.flatMap((item) => item.host === "opencode" && item.code === "opencode-config-route" && item.variable ? [item.variable] : [])
      : undefined;
    return makePlan(selection, options.entry, readImage(selection.file, SETUP_CONFIG_BYTES), routes, [...options.paths.legacyPaths[selection.host] ?? []]);
  } catch (error) {
    const refusal = asEntryRefusal(error, file ?? options.host, file);
    return { change: "refused", code: refusal.code, reason: refusal.reason, ...(refusal.file ? { file: refusal.file } : {}) };
  }
}

function result(selection: ReceiptTarget, receipt: string, change: EntryResult["change"], intent?: string): EntryResult {
  return { file: selection.file, receipt, change, ...(intent ? { intent } : {}) };
}

function assertInstalled(current: unknown, installed: unknown): void {
  if (!isDeepStrictEqual(current, installed)) {
    throw new EntryRefusal("managed-entry-changed", "managed entry changed since installation; restore the installed entry or resolve the conflict manually");
  }
}

function restoreOwned(receipt: Receipt, current: ConfigImage, file: string): ConfigImage {
  return editConfig(file, () => {
    const codec = configCodec({ ...receipt, file });
    assertInstalled(codec.read(current), codec.read(receipt.after));
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
  throw new EntryRefusal("pending-operation", `${receipt.file}: configuration changed during an interrupted ${active.kind}; inspect the configuration and receipt before retrying`);
}

export function applyEntry(plan: EntryPlan, options: ApplyEntryOptions): EntryResult {
  if (plan.change === "refused") throw new EntryRefusal(plan.code, plan.reason, { file: plan.file });
  return withRefusals(plan.file, () => applyPlan(plan, options), plan.file);
}

function applyPlan(plan: PlannedEntry, { receiptDir, env }: ApplyEntryOptions): EntryResult {
  if (!Object.hasOwn(HOSTS, plan.host)) throw new EntryRefusal("invalid-target", `${plan.host}: select a supported host and replan`);
  const selection = { host: plan.host, file: plan.file, name: plan.name };
  return withConfigLock(plan.file, () => {
    const current = readImage(plan.file, SETUP_CONFIG_BYTES);
    const { path, image, receipt } = findPackageReceipt(receiptDir, selection, plan.legacyPaths);
    let routes: readonly string[] | undefined;
    if (plan.host === "opencode") {
      if (!env) throw new EntryRefusal("opencode-environment-required", `${plan.file}: supply a fresh OpenCode environment in applyEntry options`);
      if (!Array.isArray(plan.opencodeRoutes)) {
        throw new EntryRefusal("invalid-plan", `${plan.file}: OpenCode routing snapshot is missing; generate a fresh plan`);
      }
      const updated = HOSTS.opencode.files[0].routeVariables.filter((variable) => env[variable]?.trim());
      routes = [...plan.opencodeRoutes, ...updated];
    }
    const next = makePlan(selection, plan.entry, current, routes);
    if (next.intent !== plan.intent) throw new EntryRefusal("invalid-plan", `${plan.file}: plan intent changed; generate a fresh plan`);
    if (receipt?.pending) {
      if (receipt.pending.kind !== "apply" || receipt.intent !== plan.intent) {
        throw new EntryRefusal("pending-operation", `${path}: another write is pending; retry the interrupted operation first`, { file: path });
      }
      const backup = readRecovery(path, { ...receipt, pending: receipt.pending });
      if (assertPending(receipt, current) === "start") {
        if (!sameImage(next.after, receipt.after)) throw new EntryRefusal("pending-operation", `${path}: pending image changed; inspect the receipt before retrying`);
        publishImage(plan.file, SETUP_CONFIG_BYTES, current, next.after);
      }
      const legacy = !backup.receipt ? readLegacyReceipt(receiptDir, selection, plan.legacyPaths) : undefined;
      const { pending, ...completed } = receipt;
      writeReceipt(path, image, completed);
      if (backup.receipt) writeReceipt(backup.path, backup.image);
      return appliedResult(selection, path, next.change, receipt.intent, legacy);
    }
    if (receipt && receipt.intent === plan.intent && next.change === "unchanged") {
      return result(selection, path, "unchanged", receipt.intent);
    }
    if (!sameImage(current, plan.before) || !sameImage(next.after, plan.after)) {
      throw new EntryRefusal("changed-since-preview", `${plan.file}: configuration changed since preview; generate a fresh plan`);
    }

    const legacy = receipt ? undefined : readLegacyReceipt(receiptDir, selection, plan.legacyPaths);
    const baseline = receipt ? restoreOwned(receipt, current, plan.file) : legacy ? legacyBaseline(selection, legacy, current) : current;
    if (next.change === "unchanged" && !legacy) return result(selection, path, "unchanged", next.intent);
    const completed: Receipt = {
      version: 1, ...selection, file: receipt?.file ?? selection.file, intent: next.intent, before: baseline, after: next.after,
    };
    if (next.change === "unchanged") {
      writeReceipt(path, image, completed);
      return appliedResult(selection, path, "unchanged", next.intent, legacy);
    }
    const pending = { kind: "apply", start: imageDigest(current), result: imageDigest(next.after) } as const;
    if (receipt) {
      writeRecovery(path, pending, receipt);
    } else {
      // A crash after finalizing an older write can leave its sidecar behind.
      // A fresh install must never inherit that backup.
      const stale = readRecovery(path, { ...completed, pending });
      if (stale.receipt) writeReceipt(stale.path, stale.image);
    }
    const journal = writeReceipt(path, image, { ...completed, pending });
    publishImage(plan.file, SETUP_CONFIG_BYTES, current, next.after);
    writeReceipt(path, journal, completed);
    if (receipt) {
      const backup = readRecovery(path, { ...completed, pending });
      if (backup.receipt) writeReceipt(backup.path, backup.image);
    }
    return appliedResult(selection, path, next.change, next.intent, legacy);
  });
}

function appliedResult(selection: ReceiptTarget, path: string, change: Change, intent: string, legacy?: LegacyReceipt): EntryResult {
  return { ...result(selection, path, change, intent), ...(legacy ? { legacy: true, supersedes: legacy.path } : {}) };
}

export function undoEntry(options: EntryTarget & { receiptDir: string }): EntryResult {
  const file = options.paths.paths[options.host]?.[0];
  return withRefusals(file ?? options.host, () => undoTarget(options), file);
}

function withRefusals<T>(context: string, operation: () => T, file?: string): T {
  try {
    return operation();
  } catch (error) {
    throw asEntryRefusal(error, context, file);
  }
}

function undoTarget(options: EntryTarget & { receiptDir: string }): EntryResult {
  const selection = target(options);
  const { file } = selection;
  const legacyPaths = options.paths.legacyPaths[selection.host];
  const { receiptDir } = options;
  const first = findPackageReceipt(receiptDir, selection, legacyPaths);
  const noReceipt = { ...result(selection, first.path, "unchanged"), code: "no-receipt" } as const;
  if (!first.receipt && !readLegacyReceipt(receiptDir, selection, legacyPaths)) return noReceipt;
  return withConfigLock(file, () => {
    let { path, image, receipt } = findPackageReceipt(receiptDir, selection, legacyPaths);
    if (!receipt) {
      const legacy = readLegacyReceipt(receiptDir, selection, legacyPaths);
      return legacy ? undoLegacy(selection, legacy) : noReceipt;
    }
    const current = readImage(file, SETUP_CONFIG_BYTES);
    if (receipt.pending?.kind === "apply") {
      if (imageDigest(current) !== receipt.pending.start) {
        throw new EntryRefusal("pending-operation", `${path}: an apply is pending; retry the interrupted apply before undoing`, { file: path });
      }
      const backup = readRecovery(path, { ...receipt, pending: receipt.pending });
      image = writeReceipt(path, image, backup.receipt);
      receipt = backup.receipt;
      if (receipt) writeReceipt(backup.path, backup.image);
      if (!receipt) {
        const legacy = readLegacyReceipt(receiptDir, selection, legacyPaths);
        return legacy ? undoLegacy(selection, legacy) : noReceipt;
      }
    }
    const codec = configCodec(selection);
    const change = editConfig(file, () => codec.read(receipt.before) === undefined ? "removed" : "restored");
    if (receipt.pending && assertPending(receipt, current) === "result") {
      writeReceipt(path, image);
      return result(selection, path, change, receipt.intent);
    }
    const missing = editConfig(file, () => codec.read(current) === undefined && codec.read(receipt.after) !== undefined);
    if (missing) {
      writeReceipt(path, image);
      return { ...result(selection, path, "unchanged", receipt.intent), code: "entry-already-absent" };
    }
    const restored = restoreOwned(receipt, current, file);
    const pending = { kind: "undo", start: imageDigest(current), result: imageDigest(restored) } as const;
    if (receipt.pending && receipt.pending.result !== pending.result) {
      throw new EntryRefusal("pending-operation", `${path}: pending undo changed; inspect the receipt before retrying`);
    }
    const journal = receipt.pending ? image : writeReceipt(path, image, { ...receipt, pending });
    publishImage(file, SETUP_CONFIG_BYTES, current, restored);
    writeReceipt(path, journal);
    return result(selection, path, change, receipt.intent);
  });
}

function legacyPrior(legacy: Extract<LegacyReceipt, { kind: "entry" }>, codec: ReturnType<typeof configCodec>, mode: number): unknown {
  if (legacy.priorToml === undefined) return legacy.prior;
  const prior = codec.read({ bytes: Buffer.from(legacy.priorToml).toString("base64"), mode });
  if (prior === undefined) throw new EntryRefusal("invalid-receipt", "prior TOML block has no managed entry");
  return prior;
}

function legacyBaseline(selection: ReceiptTarget, legacy: LegacyReceipt, current: ConfigImage): ConfigImage {
  return editConfig(selection.file, () => {
    const codec = configCodec(selection, true);
    if (legacy.kind === "agent-mem") {
      const installed = codec.read(legacy.after);
      if (!record(installed)) throw new EntryRefusal("invalid-receipt", "legacy receipt has no installed MCP entry");
      assertInstalled(codec.read(current), installed);
      const restored = codec.restore(legacy.before, legacy.after, current, { ownedOnly: true });
      return { bytes: restored.bytes, mode: current.mode };
    }
    assertInstalled(codec.read(current), legacy.installed);
    const prior = legacyPrior(legacy, codec, current.mode);
    const restored = codec.put(current, prior, { keepEmpty: legacy.keyExisted });
    if (!legacy.existed && restored.bytes !== null) {
      const text = decoder.decode(Buffer.from(restored.bytes, "base64"));
      const empty = HOSTS[selection.host].format.kind === "toml" ? text.trim() === "" : /^\s*\{\s*\}\s*$/.test(text);
      if (empty) return { bytes: null, mode: current.mode };
    }
    return restored;
  });
}

export interface EntryReceipt {
  file: string;
  receipt: string;
  intent: string;
  before: ConfigImage;
  after: ConfigImage;
  pending?: Receipt["pending"];
  legacy?: true;
}

function legacyView(selection: ReceiptTarget, legacy: LegacyReceipt): EntryReceipt {
  const { file } = selection;
  if (legacy.kind === "agent-mem") {
    return { file, receipt: legacy.path, intent: legacy.intent, before: legacy.before, after: legacy.after, legacy: true };
  }
  const empty = { bytes: null, mode: 0o600 };
  const codec = configCodec(selection, true);
  return editConfig(file, () => {
    const prior = legacyPrior(legacy, codec, empty.mode);
    const format = HOSTS[selection.host].format;
    const initialText = format.kind === "json" ? "{}" : legacy.keyExisted ? `[${format.table.join(".")}]\n` : "";
    const initial = legacy.existed ? { ...empty, bytes: Buffer.from(initialText).toString("base64") } : empty;
    const before = codec.put(initial, prior, { keepEmpty: legacy.keyExisted });
    return {
      file, receipt: legacy.path, intent: digest([selection.host, file, selection.name, legacy.installed]),
      before, after: codec.put(before, legacy.installed), legacy: true,
    };
  });
}

export function readEntryReceipt(options: EntryTarget & { receiptDir: string }): EntryReceipt | undefined {
  const file = options.paths.paths[options.host]?.[0];
  return withRefusals(file ?? options.host, () => {
    const selection = target(options);
    const legacyPaths = options.paths.legacyPaths[options.host];
    const { path, receipt } = findPackageReceipt(options.receiptDir, selection, legacyPaths);
    if (receipt) {
      const { file, intent, before, after, pending } = receipt;
      return { file, receipt: path, intent, before, after, ...(pending ? { pending } : {}) };
    }
    const legacy = readLegacyReceipt(options.receiptDir, selection, legacyPaths);
    return legacy ? legacyView(selection, legacy) : undefined;
  }, file);
}

function undoLegacy(selection: ReceiptTarget, legacy: LegacyReceipt): EntryResult {
  const { file } = selection;
  const current = readImage(file, SETUP_CONFIG_BYTES);
  const view = legacyView(selection, legacy);
  const { live, prior } = editConfig(file, () => {
    const codec = configCodec(selection, true);
    return { live: codec.read(current), prior: codec.read(view.before) };
  });
  if (live === undefined || isDeepStrictEqual(live, prior)) {
    const code = live === undefined ? "entry-already-absent" : "entry-already-restored";
    return { ...result(selection, legacy.path, "unchanged", view.intent), code, legacy: true };
  }
  const restored = legacyBaseline(selection, legacy, current);
  publishImage(file, SETUP_CONFIG_BYTES, current, restored);
  return { ...result(selection, legacy.path, prior === undefined ? "removed" : "restored", view.intent), legacy: true };
}
