import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { applyEntry, planEntry, readEntryReceipt, realPath, resolveHostPaths, undoEntry, type HostId } from "@staix/agent-hosts";

const roots: string[] = [];
afterEach(() => { for (const home of roots.splice(0)) rmSync(home, { recursive: true, force: true }); });
function scratch(): string {
  const home = realPath(mkdtempSync(join(tmpdir(), "agent-hosts-legacy-")));
  roots.push(home);
  return home;
}
function put(file: string, value: string, mode = 0o600): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, value, { mode });
}
const legacyFilename = (host: HostId, file: string): string =>
  `${host}-${createHash("sha256").update(file).digest("hex").slice(0, 16)}.json`;
const asImage = (text: string) => ({ bytes: Buffer.from(text).toString("base64"), mode: 0o600 });

interface Fixture {
  commit: string;
  host: HostId;
  name: string;
  file: string;
  workspaceRoot?: string;
  receiptDir: string;
  mode: number;
  before: string;
  after: string;
  receipt: {
    changes?: Array<{
      path: string;
      before: { bytes: string | null };
      after: { bytes: string | null };
      start?: { bytes: string | null };
    }>;
  };
}

function replay(consumer: string, version: number, host: "kimi" | "agy" = "kimi") {
  const source = join(import.meta.dir, "../fixtures/receipts", consumer, `${host === "agy" ? "agy-" : ""}v${version}.json`);
  const fixture = JSON.parse(readFileSync(source, "utf8")) as Fixture;
  const home = scratch();
  const path = (text: string) => text.replaceAll("$FIXTURE", home);
  const file = path(fixture.file);
  const receiptDir = path(fixture.receiptDir);
  const workspaceRoot = fixture.workspaceRoot && path(fixture.workspaceRoot);
  const memoryFilename = workspaceRoot
    ? `agy-${createHash("sha256").update(JSON.stringify(workspaceRoot)).digest("hex")}.json`
    : `${fixture.host}.json`;
  const receiptFile = join(receiptDir, consumer === "agent-mem" ? memoryFilename : legacyFilename(fixture.host, file));
  for (const change of fixture.receipt.changes ?? []) {
    for (const image of [change.before, change.after, change.start]) {
      if (image?.bytes != null) image.bytes = Buffer.from(path(Buffer.from(image.bytes, "base64").toString("utf8"))).toString("base64");
    }
  }
  const receipt = path(JSON.stringify(fixture.receipt));
  put(receiptFile, receipt);
  put(file, path(fixture.after), fixture.mode);
  const hook = fixture.receipt.changes?.[1];
  const hookText = hook?.after.bytes == null ? undefined : Buffer.from(hook.after.bytes, "base64").toString("utf8");
  const hookFile = hook ? path(hook.path) : undefined;
  if (hookFile && hookText) put(hookFile, hookText);
  expect(fixture.host).toBe(host);
  const paths = resolveHostPaths({
    env: {}, home, hosts: [host],
    ...(workspaceRoot ? { workspaceRoot, scopes: ["project"] } : {}),
  });
  return {
    file, receiptFile, receipt, before: path(fixture.before), target: { host: fixture.host, name: fixture.name, paths, receiptDir },
    hookFile, hookText,
  };
}

test.each([
  ["vault-mem", 1], ["agent-research", 1], ["agent-mem", 1], ["agent-mem", 2],
] as const)("%s v%i emitted receipt restores its MCP before-image", (consumer, version) => {
  const { file, receiptFile, receipt, before, target, hookFile, hookText } = replay(consumer, version);
  expect(undoEntry(target)).toMatchObject({ change: "restored", file, receipt: receiptFile, legacy: true });
  expect(readFileSync(file, "utf8")).toBe(before);
  expect(readFileSync(receiptFile, "utf8")).toBe(receipt);
  if (hookFile && hookText) expect(readFileSync(hookFile, "utf8")).toBe(hookText);
});

test.each(["vault-mem", "agent-research", "agent-mem"] as const)(
  "%s emitted agy receipt restores one project's MCP entry",
  (consumer) => {
    const { file, receiptFile, receipt, before, target } = replay(consumer, 1, "agy");
    expect(undoEntry(target)).toMatchObject({ change: "restored", file, receipt: receiptFile, legacy: true });
    expect(readFileSync(file, "utf8")).toBe(before);
    expect(readFileSync(receiptFile, "utf8")).toBe(receipt);
  },
);

test("agent-mem agy undo ignores a journal from another project", () => {
  const { file, receiptFile, receipt, target } = replay("agent-mem", 1, "agy");
  const home = target.paths.home;
  const workspaceRoot = join(home, "another-workspace");
  const paths = resolveHostPaths({ home, env: {}, hosts: ["agy"], scopes: ["project"], workspaceRoot });
  const otherFile = join(workspaceRoot, ".agents/mcp_config.json");
  const installed = readFileSync(file, "utf8");
  put(otherFile, installed);

  expect(undoEntry({ ...target, paths })).toMatchObject({ change: "unchanged", code: "no-receipt" });
  expect(readFileSync(otherFile, "utf8")).toBe(installed);
  expect(readFileSync(file, "utf8")).toBe(installed);
  expect(readFileSync(receiptFile, "utf8")).toBe(receipt);
});

test("legacy undo refuses a changed owned entry and a foreign receipt path", () => {
  const { file, receiptFile, receipt, target } = replay("vault-mem", 1);
  const live = '{"mcpServers":{"vmem":{"command":"changed","args":[]}}}';
  put(file, live);
  expect(() => undoEntry(target)).toThrow(`${file}: managed entry changed`);
  expect(readFileSync(file, "utf8")).toBe(live);
  expect(readFileSync(receiptFile, "utf8")).toBe(receipt);
  put(receiptFile, JSON.stringify({ ...JSON.parse(receipt), file: file + ".foreign" }));
  expect(() => undoEntry(target)).toThrow("invalid or foreign setup receipt");
  expect(readFileSync(file, "utf8")).toBe(live);
});

test("legacy receipt paths use the same link guard as package receipts", () => {
  const { file, receiptFile, target } = replay("agent-mem", 2);
  const installed = readFileSync(file, "utf8");
  renameSync(receiptFile, receiptFile + ".source");
  symlinkSync(receiptFile + ".source", receiptFile);
  expect(() => undoEntry(target)).toThrow(`${receiptFile}: unsafe path`);
  expect(readFileSync(file, "utf8")).toBe(installed);
});

test("uses a receipt bound to a known legacy path without opening that historical config", () => {
  const { file, before, receiptFile, receipt, target } = replay("vault-mem", 1);
  const historical = join(target.paths.home, "legacy", "mcp.json");
  const historicalReceipt = join(target.receiptDir, legacyFilename(target.host, historical));
  rmSync(receiptFile);
  put(historicalReceipt, JSON.stringify({ ...JSON.parse(receipt), file: historical }));
  target.paths.legacyPaths[target.host] = [historical];
  expect(undoEntry(target).receipt).toBe(historicalReceipt);
  expect(readFileSync(file, "utf8")).toBe(before);
  expect(existsSync(dirname(historical))).toBe(false);
});

test("Qwen MCP-only undo preserves hook edits from the same agent-mem receipt", () => {
  const host = "qwen", home = scratch();
  const paths = resolveHostPaths({ env: {}, home, hosts: [host] });
  const file = paths.paths[host]![0]!;
  const receiptDir = join(home, "receipts");
  const old = '{"mcpServers":{},"hooks":{"fixture":"old"}}';
  const installed = '{"mcpServers":{"amem":{"command":"bun","args":[]}},"hooks":{"fixture":"updated"}}';
  put(file, installed);
  put(join(receiptDir, "qwen.json"), JSON.stringify({
    version: 2, target: host, intent: "a".repeat(64), phase: "applied",
    changes: [{ key: "qwen:0", path: file, before: asImage(old), after: asImage(installed) }],
  }));
  expect(undoEntry({ host, paths, name: "amem", receiptDir }).change).toBe("removed");
  expect(readFileSync(file, "utf8")).toBe('{"mcpServers":{},"hooks":{"fixture":"updated"}}');
});

test.each(["vmem", "ares"] as const)("restores only the %s TOML entry from its legacy prior block", (name) => {
  const host = "codex", home = scratch();
  const paths = resolveHostPaths({ env: {}, home, hosts: [host] });
  const file = paths.paths[host]![0]!;
  const receiptDir = join(home, "receipts");
  const unrelated = "[mcp_servers.other]\r\ncommand = 'keep' # comment\r\ncount = 1_000\r\n";
  const installed = { command: "bun", args: ["mcp"] };
  const prior = { command: "previous", args: ["restore"], env: { VAR: "a" } };
  const block = `[mcp_servers.${name}]\ncommand = 'previous'\nargs = ['restore']\n[mcp_servers.${name}.env]\nVAR = 'a'\n`;
  put(file, unrelated + `\r\n[mcp_servers.${name}]\r\ncommand = 'bun'\r\nargs = ['mcp']\r\n`);
  const legacy = name === "vmem" ? { version: 1, priorToml: block.trimEnd().split("\n") } : { v: 1, priorPresent: true, priorToml: block };
  put(join(receiptDir, legacyFilename(host, file)), JSON.stringify({
    ...legacy, target: host, file, existed: true, keyExisted: true, prior, installed,
  }));
  expect(undoEntry({ host, paths, name, receiptDir }).change).toBe("restored");
  const text = readFileSync(file, "utf8");
  expect(text).toContain(unrelated);
  expect(Bun.TOML.parse(text)).toMatchObject({ mcp_servers: { [name]: prior } });
});

test("agent-mem undo keeps live sibling formatting even when its journal has different before bytes", () => {
  const { file, receiptFile, receipt, target } = replay("agent-mem", 1);
  const raw = JSON.parse(receipt);
  const changedBefore = Buffer.from(raw.changes[0].before.bytes, "base64").toString("utf8")
    .replace('"command": "keep"', '"command" : "keep"');
  raw.changes[0].before = asImage(changedBefore);
  put(receiptFile, JSON.stringify(raw));
  expect(undoEntry(target).change).toBe("restored");
  expect(readFileSync(file, "utf8")).toContain('"command": "keep"');
});

test.each([
  ["vault-mem", 1], ["agent-research", 1], ["agent-mem", 1], ["agent-mem", 2],
] as const)("%s v%i repeated undo retains the legacy receipt without publishing", (consumer, version) => {
  const { file, receiptFile, receipt, before, target } = replay(consumer, version);
  undoEntry(target);
  const inode = statSync(file).ino;
  expect(undoEntry(target)).toMatchObject({ change: "unchanged", code: "entry-already-restored", file, receipt: receiptFile, legacy: true });
  expect(statSync(file).ino).toBe(inode);
  expect(readFileSync(file, "utf8")).toBe(before);
  expect(readFileSync(receiptFile, "utf8")).toBe(receipt);
});

test("a retained legacy receipt distinguishes an already absent entry from no receipt", () => {
  const { receiptFile, receipt, target } = replay("vault-mem", 1);
  put(receiptFile, JSON.stringify({ ...JSON.parse(receipt), prior: null }));
  expect(undoEntry(target).change).toBe("removed");
  expect(undoEntry(target)).toMatchObject({ change: "unchanged", code: "entry-already-absent", legacy: true });
});

test.each([
  ["vault-mem", 1], ["agent-research", 1], ["agent-mem", 1], ["agent-mem", 2],
] as const)("%s v%i is superseded without losing its original prior entry", (consumer, version) => {
  const { file, receiptFile, receipt, before, target } = replay(consumer, version);
  expect(readEntryReceipt(target)).toMatchObject({ file, receipt: receiptFile, legacy: true });
  const plan = planEntry({ ...target, entry: { command: "new", args: ["mcp"] } });
  if (plan.change === "refused") throw new Error(plan.reason);
  expect(plan.current).toHaveProperty("command");
  const applied = applyEntry(plan, { receiptDir: target.receiptDir });
  expect(applied).toMatchObject({ change: "replace", intent: plan.intent, legacy: true, supersedes: receiptFile });
  const modern = readEntryReceipt(target);
  expect(modern).toMatchObject({ file, receipt: applied.receipt, intent: plan.intent, before: asImage(before) });
  expect(modern?.legacy).toBeUndefined();
  expect(readFileSync(receiptFile, "utf8")).toBe(receipt);
  expect(undoEntry(target)).toMatchObject({ change: "restored", intent: plan.intent });
  expect(readFileSync(file, "utf8")).toBe(before);
  expect(undoEntry(target)).toMatchObject({ change: "unchanged", code: "entry-already-restored", legacy: true });
});

test("a foreign legacy entry blocks promotion and names the file", () => {
  const { file, target } = replay("agent-research", 1);
  const current = '{"mcpServers":{"ares":{"command":"another","args":[]}}}';
  put(file, current);
  const plan = planEntry({ ...target, entry: { command: "ours", args: ["mcp"] } });
  expect(() => applyEntry(plan, { receiptDir: target.receiptDir })).toThrow("managed entry changed since installation");
  expect(readFileSync(file, "utf8")).toBe(current);
  expect(readEntryReceipt(target)?.legacy).toBe(true);
});

test("Jcode legacy undo leaves a sibling alias intact and restores only the canonical entry", () => {
  const host = "jcode", home = scratch(), name = "amem";
  const paths = resolveHostPaths({ home, env: {}, hosts: [host] });
  const file = paths.paths.jcode![0]!, receiptDir = join(home, "receipts");
  const prior = '{"mcpServers":{"amem":{"command":"prior"},"outside":{"command":"untouched"}}}';
  const installed = '{"servers":{"amem":{"command":"installed"},"outside":{"command":"untouched"}}}';
  const alias = '"mcpServers" : { "amem" : { "command" : "separate" } }';
  put(file, installed.slice(0, -1) + "," + alias + "}");
  put(join(receiptDir, "jcode.json"), JSON.stringify({
    version: 1, target: host, intent: "a".repeat(64), phase: "applied",
    changes: [{ key: "jcode:0", path: file, before: asImage(prior), after: asImage(installed) }],
  }));
  expect(undoEntry({ host, paths, name, receiptDir }).change).toBe("restored");
  expect(readFileSync(file, "utf8")).toBe(installed.replace('"installed"', '"prior"').slice(0, -1) + "," + alias + "}");
});

for (const [consumer, version] of [
  ["vault-mem", 1], ["agent-research", 1], ["agent-mem", 1], ["agent-mem", 2],
] as const) {
  test.each(["absent", "restored"] as const)(
    `${consumer} v${version} supersedes a retained legacy receipt whose entry is already %s`,
    (state) => {
      const { file, receiptFile, before, target } = replay(consumer, version);
      const current = state === "restored" ? before : '{"unrelated":true}';
      put(file, current);
      const plan = planEntry({ ...target, entry: { command: "new", args: ["mcp"] } });
      expect(plan.change).toBe(state === "restored" ? "replace" : "add");
      const applied = applyEntry(plan, { receiptDir: target.receiptDir });
      expect(applied).toMatchObject({ legacy: true, supersedes: receiptFile });
      expect(readEntryReceipt(target)?.before).toEqual(asImage(current));
      expect(undoEntry(target).change).toBe(state === "restored" ? "restored" : "removed");
      expect(readFileSync(file, "utf8")).toBe(current);
    },
  );
}
