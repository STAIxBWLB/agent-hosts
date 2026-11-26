import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { realPath, resolveHostPaths, undoEntry, type HostId } from "@staix/agent-hosts";

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

function replay(consumer: string, version: number) {
  const source = join(import.meta.dir, "../fixtures/receipts", consumer, `v${version}.json`);
  const fixture = JSON.parse(readFileSync(source, "utf8")) as Fixture;
  const home = scratch();
  const path = (text: string) => text.replaceAll("$FIXTURE", home);
  const file = path(fixture.file);
  const receiptDir = path(fixture.receiptDir);
  const receiptFile = join(receiptDir, consumer === "agent-mem" ? `${fixture.host}.json` : legacyFilename(fixture.host, file));
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
  const paths = resolveHostPaths({ env: {}, home, hosts: [fixture.host] });
  return {
    file, receiptFile, receipt, before: path(fixture.before), target: { host: fixture.host, name: fixture.name, paths, receiptDir },
    hookFile, hookText,
  };
}

test.each([
  ["vault-mem", 1], ["agent-research", 1], ["agent-mem", 1], ["agent-mem", 2],
] as const)("%s v%i emitted receipt restores its MCP before-image", (consumer, version) => {
  const { file, receiptFile, receipt, before, target, hookFile, hookText } = replay(consumer, version);
  expect(undoEntry(target)).toEqual({ change: "restored", file, receipt: receiptFile });
  expect(readFileSync(file, "utf8")).toBe(before);
  expect(readFileSync(receiptFile, "utf8")).toBe(receipt);
  if (hookFile && hookText) expect(readFileSync(hookFile, "utf8")).toBe(hookText);
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
