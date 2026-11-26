import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { createHash } from "node:crypto";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, truncateSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { applyEntry, EntryRefusal, planEntry, readEntryReceipt, realPath, REFUSAL_CODES, resolveHostPaths, SETUP_CONFIG_BYTES, undoEntry, type ConfigImage, type RefusalCode } from "@staix/agent-hosts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(host: "kimi" | "codex" = "kimi") {
  const home = realPath(mkdtempSync(join(tmpdir(), "agent-hosts-safety-")));
  roots.push(home);
  const paths = resolveHostPaths({ home, env: {}, hosts: [host] });
  const file = paths.paths[host]![0]!;
  const target = { host, paths, name: "managed" };
  return { home, file, target, receiptDir: join(home, "receipts") };
}

test("refuses link targets and link ancestors without opening or changing the physical configuration", () => {
  const { home, file, target, receiptDir } = fixture();
  const outside = join(home, "outside");
  mkdirSync(outside);
  const physical = join(outside, "mcp.json");
  writeFileSync(physical, "{}");
  symlinkSync(outside, dirname(file), "dir");
  const plan = planEntry({ ...target, entry: { command: "fixture" } });
  if (plan.change !== "refused") throw new Error("expected linked configuration to be refused");
  expect(plan.code).toBe("unsafe-path");
  expect(REFUSAL_CODES).toContain(plan.code);
  expect(plan.reason).toContain(file);
  expect(() => applyEntry(plan, { receiptDir })).toThrow("without links");
  expect(readFileSync(physical, "utf8")).toBe("{}");

  unlinkSync(dirname(file));
  mkdirSync(dirname(file));
  symlinkSync(join(outside, "missing.json"), file);
  expect(planEntry({ ...target, entry: {} }).change).toBe("refused");
  unlinkSync(file);
  linkSync(physical, file);
  expect(planEntry({ ...target, entry: {} }).change).toBe("refused");
});

test("refuses a linked receipt directory and a linked receipt file", () => {
  const { home, file, target, receiptDir } = fixture();
  const physical = join(home, "other");
  mkdirSync(physical);
  symlinkSync(physical, receiptDir, "dir");
  const plan = planEntry({ ...target, entry: { command: "fixture" } });
  expect(() => applyEntry(plan, { receiptDir })).toThrow(receiptDir);
  expect(existsSync(file)).toBe(false);
  unlinkSync(receiptDir);
  const applied = applyEntry(plan, { receiptDir });
  const installed = readFileSync(file, "utf8");
  const other = join(physical, "receipt.json");
  renameSync(applied.receipt, other);
  symlinkSync(other, applied.receipt);
  expect(() => undoEntry({ ...target, receiptDir })).toThrow(applied.receipt);
  expect(readFileSync(file, "utf8")).toBe(installed);
});

test.each([
  ["kimi", '{"mcpServers":{},"mcpServers":{}}'],
  ["kimi", '{// invalid JSON\n"mcpServers":{}}'],
  ["codex", "[mcp_servers\n"],
  ["codex", '[[mcp_servers]]\ncommand = "other"\n'],
] as const)("syntax and ambiguity refusal names the %s file and next step", (host, original) => {
  const { file, target, receiptDir } = fixture(host);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, original);
  const plan = planEntry({ ...target, entry: { command: "fixture" } });
  expect(plan.change).toBe("refused");
  if (plan.change === "refused") expect(plan.code).toBe("invalid-configuration");
  expect(() => applyEntry(plan, { receiptDir })).toThrow(`${file}:`);
  expect(() => applyEntry(plan, { receiptDir })).toThrow("inspect the configuration");
  expect(readFileSync(file, "utf8")).toBe(original);
  expect(existsSync(receiptDir)).toBe(false);
});

test("bounds configuration and receipt reads", () => {
  const { file, target, receiptDir } = fixture();
  const applied = applyEntry(planEntry({ ...target, entry: { command: "fixture" } }), { receiptDir });
  truncateSync(file, SETUP_CONFIG_BYTES + 1);
  expect(planEntry({ ...target, entry: {} })).toMatchObject({ change: "refused", code: "size-limit", reason: expect.stringContaining("exceeds") });
  truncateSync(applied.receipt, 3 * SETUP_CONFIG_BYTES);
  expect(() => undoEntry({ ...target, receiptDir })).toThrow(`${applied.receipt}: exceeds`);
});

test("exclusive lock refuses a stale lock and leaves its contents unchanged", () => {
  const { file, target, receiptDir } = fixture();
  mkdirSync(dirname(file), { recursive: true });
  const lock = file + ".agent-hosts.lock";
  writeFileSync(lock, "previous writer");
  const plan = planEntry({ ...target, entry: { command: "fixture" } });
  expectRefusal(() => applyEntry(plan, { receiptDir }), "lock-held");
  expect(() => applyEntry(plan, { receiptDir })).toThrow(lock);
  expect(() => applyEntry(plan, { receiptDir })).toThrow("remove the lock manually");
  expect(readFileSync(lock, "utf8")).toBe("previous writer");
  expect(existsSync(file)).toBe(false);
});

test("a stale preview cannot overwrite a third-party edit", () => {
  const { file, target, receiptDir } = fixture();
  const plan = planEntry({ ...target, entry: { command: "fixture" } });
  mkdirSync(dirname(file), { recursive: true });
  const thirdParty = '{"unrelated":true}';
  writeFileSync(file, thirdParty);
  expectRefusal(() => applyEntry(plan, { receiptDir }), "changed-since-preview");
  expect(() => applyEntry(plan, { receiptDir })).toThrow("generate a fresh plan");
  expect(readFileSync(file, "utf8")).toBe(thirdParty);
  expect(existsSync(receiptDir)).toBe(false);
});

test("two concurrent applies to one config cannot both publish", async () => {
  const { home, file, target, receiptDir } = fixture();
  const gate = join(home, "go");
  const script = join(home, "apply.ts");
  const library = join(import.meta.dir, "../src/index.ts");
  writeFileSync(script, `
import { existsSync, writeFileSync } from "node:fs";
import { applyEntry } from ${JSON.stringify(library)};
const [plan, receiptDir, gate, ready] = process.argv.slice(2);
writeFileSync(ready, "");
while (!existsSync(gate)) await Bun.sleep(2);
try { applyEntry(JSON.parse(plan), { receiptDir }); }
catch (error) { console.error(error.message); process.exitCode = 1; }
`);
  const commands = ["first", "second"];
  const ready = commands.map((command) => join(home, `${command}.ready`));
  const children = commands.map((command, index) => Bun.spawn([
    process.execPath, script, JSON.stringify(planEntry({ ...target, entry: { command } })),
    index === 0 ? receiptDir : join(home, "other-receipts"), gate, ready[index]!,
  ], { cwd: home, env: { HOME: home }, stdout: "ignore", stderr: "pipe" }));
  try {
    const deadline = performance.now() + 3000;
    while (!ready.every(existsSync) && performance.now() < deadline) await Bun.sleep(5);
    expect(ready.every(existsSync)).toBe(true);
    writeFileSync(gate, "");
    const codes = await Promise.all(children.map((child) => child.exited));
    expect([...codes].sort()).toEqual([0, 1]);
    const winner = commands[codes.indexOf(0)]!;
    const loser = children[codes.indexOf(1)]!;
    expect(await new Response(loser.stderr).text()).toMatch(/holds this lock|generate a fresh plan/);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ mcpServers: { managed: { command: winner } } });
  } finally {
    for (const child of children) if (child.exitCode === null) child.kill();
    await Promise.all(children.map((child) => child.exited));
  }
});

const imageKey = (image: ConfigImage): string => createHash("sha256")
  .update(JSON.stringify([image.bytes, image.bytes === null ? null : image.mode])).digest("hex");

test("retries an interrupted apply and finalizes an interrupted undo", () => {
  const { file, target, receiptDir } = fixture();
  const plan = planEntry({ ...target, entry: { command: "fixture" } });
  if (plan.change === "refused") throw new Error(plan.reason);
  const applied = applyEntry(plan, { receiptDir });
  const receipt = JSON.parse(readFileSync(applied.receipt, "utf8"));
  const before = imageKey(plan.before), after = imageKey(plan.after);
  writeFileSync(applied.receipt, JSON.stringify({ ...receipt, pending: { kind: "apply", start: before, result: after } }));
  unlinkSync(file);
  expect(applyEntry(plan, { receiptDir }).change).toBe("add");
  expect(JSON.parse(readFileSync(applied.receipt, "utf8")).pending).toBeUndefined();
  writeFileSync(applied.receipt, JSON.stringify({ ...receipt, pending: { kind: "undo", start: after, result: before } }));
  unlinkSync(file);
  expect(undoEntry({ ...target, receiptDir }).change).toBe("removed");
  expect(existsSync(applied.receipt)).toBe(false);
});

test("refuses TOML inline parents when editing would re-render a sibling entry", () => {
  const { file, target, receiptDir } = fixture("codex");
  mkdirSync(dirname(file), { recursive: true });
  const original = 'mcp_servers = { managed = { command = "old" }, other = { command="keep", number=1_000 } } # keep\n';
  writeFileSync(file, original);
  const plan = planEntry({ ...target, entry: { command: "new" } });
  expect(() => applyEntry(plan, { receiptDir })).toThrow("convert the parent to standard TOML tables");
  expect(readFileSync(file, "utf8")).toBe(original);
  expect(existsSync(receiptDir)).toBe(false);
});

function expectRefusal(run: () => unknown, code: RefusalCode): void {
  try {
    run();
  } catch (error) {
    if (!(error instanceof EntryRefusal)) throw error;
    expect(error.code).toBe(code);
    expect(REFUSAL_CODES).toContain(error.code);
    expect(error.reason).toBe(error.message);
    return;
  }
  throw new Error(`expected refusal ${code}`);
}

function failConfigPublication(file: string, run: () => void): void {
  const rename = fs.renameSync;
  const mock = spyOn(fs, "renameSync").mockImplementation((from, to) => {
    if (to === file) throw new Error("injected config publication failure");
    rename(from, to);
  });
  try {
    run();
  } finally {
    mock.mockRestore();
  }
}

test("a first failed publication leaves a resumable v1 journal, and undo can cancel it", () => {
  const { file, target, receiptDir } = fixture();
  const options = { ...target, receiptDir };
  const plan = planEntry({ ...target, entry: { command: "ours" } });
  failConfigPublication(file, () => {
    expect(() => applyEntry(plan, options)).toThrow("injected config publication failure");
  });
  expect(readEntryReceipt(options)?.pending?.kind).toBe("apply");
  expect(existsSync(file)).toBe(false);
  expect(undoEntry(options)).toMatchObject({ change: "unchanged", code: "no-receipt" });
  expect(readEntryReceipt(options)).toBeUndefined();

  failConfigPublication(file, () => {
    expect(() => applyEntry(plan, options)).toThrow("injected config publication failure");
  });
  expect(applyEntry(plan, options).change).toBe("add");
  expect(readEntryReceipt(options)?.pending).toBeUndefined();
});

test("undo of an unpublished replacement restores and uses its previous completed receipt", () => {
  const { file, target, receiptDir } = fixture();
  const options = { ...target, receiptDir };
  mkdirSync(dirname(file), { recursive: true });
  const baseline = '{"mcpServers":{"managed":{"command":"original"}}}';
  writeFileSync(file, baseline);
  const installed = applyEntry(planEntry({ ...target, entry: { command: "first" } }), options);
  const replacement = planEntry({ ...target, entry: { command: "second" } });
  failConfigPublication(file, () => {
    expect(() => applyEntry(replacement, options)).toThrow("injected config publication failure");
  });
  expect(readEntryReceipt(options)?.pending?.kind).toBe("apply");
  expect(undoEntry(options)).toMatchObject({ change: "restored", intent: installed.intent });
  expect(readFileSync(file, "utf8")).toBe(baseline);
  expect(readEntryReceipt(options)).toBeUndefined();
  expect(fs.readdirSync(receiptDir)).toEqual([]);
});

test("undo of an already published pending apply names its receipt and asks for retry", () => {
  const { file, target, receiptDir } = fixture();
  const plan = planEntry({ ...target, entry: { command: "fixture" } });
  if (plan.change === "refused") throw new Error(plan.reason);
  const applied = applyEntry(plan, { receiptDir });
  const receipt = JSON.parse(readFileSync(applied.receipt, "utf8"));
  writeFileSync(applied.receipt, JSON.stringify({
    ...receipt, pending: { kind: "apply", start: imageKey(plan.before), result: imageKey(plan.after) },
  }));
  try {
    undoEntry({ ...target, receiptDir });
    throw new Error("expected a pending apply refusal");
  } catch (error) {
    if (!(error instanceof EntryRefusal)) throw error;
    expect(error.code).toBe("pending-operation");
    expect(error.file).toBe(applied.receipt);
    expect(error.reason).toContain("retry the interrupted apply");
  }
  expect(existsSync(file)).toBe(true);
});
