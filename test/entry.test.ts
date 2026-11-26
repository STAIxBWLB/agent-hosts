import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { applyEntry, planEntry, realPath, resolveHostPaths, undoEntry } from "@staix/agent-hosts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(host: "codex" | "kimi" | "jcode" = "kimi") {
  const home = realPath(mkdtempSync(join(tmpdir(), "agent-hosts-entry-")));
  roots.push(home);
  const paths = resolveHostPaths({ home, env: {}, hosts: [host] });
  const file = paths.paths[host]![0]!;
  const target = { host, paths, name: "managed" };
  const receiptDir = join(home, "receipts");
  return { file, receiptDir, target };
}

test("preview is read-only and apply creates a versioned receipt; undo removes a new file", () => {
  const { file, receiptDir, target } = fixture();
  const plan = planEntry({ ...target, entry: { command: "fixture", args: ["mcp"] } });
  expect(plan.change).toBe("add");
  expect(existsSync(dirname(file))).toBe(false);
  expect(existsSync(receiptDir)).toBe(false);
  const applied = applyEntry(plan, { receiptDir });
  expect(applied.change).toBe("add");
  expect(JSON.parse(readFileSync(applied.receipt, "utf8"))).toMatchObject({ version: 1, file, name: "managed" });
  expect(statSync(applied.receipt).mode & 0o777).toBe(0o600);
  expect(applyEntry(plan, { receiptDir }).change).toBe("unchanged");
  expect(undoEntry({ ...target, receiptDir }).change).toBe("removed");
  expect(existsSync(file)).toBe(false);
  expect(existsSync(applied.receipt)).toBe(false);
  expect(undoEntry({ ...target, receiptDir }).change).toBe("unchanged");
});

test("JSON replace and undo are byte-exact outside the entry and preserve mode", () => {
  const { file, receiptDir, target } = fixture();
  mkdirSync(dirname(file), { recursive: true });
  const before = '{\r\n "mcpServers": { "managed" : { "command" : "before" }, "other": {"x":9007199254740993} }, "n":1e99\r\n}\r\n';
  writeFileSync(file, before, { mode: 0o640 });
  const initialInode = statSync(file).ino;
  const plan = planEntry({ ...target, entry: { command: "after" } });
  expect(applyEntry(plan, { receiptDir }).change).toBe("replace");
  const installed = before.replace('{ "command" : "before" }', '{"command":"after"}');
  expect(readFileSync(file, "utf8")).toBe(installed);
  expect(statSync(file).mode & 0o777).toBe(0o640);
  expect(statSync(file).ino).not.toBe(initialInode);
  writeFileSync(file, installed.replace("1e99", "2e99"));
  chmodSync(file, 0o644);
  expect(undoEntry({ ...target, receiptDir }).change).toBe("restored");
  expect(readFileSync(file, "utf8")).toBe(before.replace("1e99", "2e99"));
  expect(statSync(file).mode & 0o777).toBe(0o644);
});

test("refreshing an installed entry retains its original baseline and intervening edits", () => {
  const { file, receiptDir, target } = fixture("jcode");
  mkdirSync(dirname(file), { recursive: true });
  const before = '{"mcpServers":{"other":{"command":"keep"}},"unrelated":1e99}\n';
  writeFileSync(file, before);
  applyEntry(planEntry({ ...target, entry: { command: "first" } }), { receiptDir });
  const changed = readFileSync(file, "utf8").replace("1e99", "2e99");
  writeFileSync(file, changed);
  applyEntry(planEntry({ ...target, entry: { command: "second" } }), { receiptDir });
  expect(undoEntry({ ...target, receiptDir }).change).toBe("removed");
  expect(readFileSync(file, "utf8")).toBe(before.replace("1e99", "2e99"));
});

test("TOML undo keeps unrelated changes and restores the prior entry", () => {
  const { file, receiptDir, target } = fixture("codex");
  mkdirSync(dirname(file), { recursive: true });
  const other = "[mcp_servers.other]\r\ncommand = 'keep' # comment\r\nnumber = 1_000\r\n";
  const prefix = "title = 'original'\r\n\r\n";
  const original = prefix + other + "\r\n[mcp_servers.managed]\r\ncommand = 'before'\r\n";
  writeFileSync(file, original);
  applyEntry(planEntry({ ...target, entry: { command: "after", args: ["mcp"] } }), { receiptDir });
  const installed = readFileSync(file, "utf8");
  expect(installed).toContain(other);
  const changed = installed.replace("'original'", "'edited'");
  writeFileSync(file, changed);
  expect(undoEntry({ ...target, receiptDir }).change).toBe("restored");
  const restored = readFileSync(file, "utf8");
  expect(restored.startsWith(prefix.replace("'original'", "'edited'"))).toBe(true);
  expect(restored).toContain(other);
  expect(Bun.TOML.parse(restored)).toMatchObject({ mcp_servers: { managed: { command: "before" } } });
});

test("undo refuses a third-party change or removal of the managed entry", () => {
  const { file, receiptDir, target } = fixture();
  const applied = applyEntry(planEntry({ ...target, entry: { command: "ours" } }), { receiptDir });
  const receiptBefore = readFileSync(applied.receipt, "utf8");
  for (const edited of ['{"mcpServers":{"managed":{"command":"theirs"}}}', '{"mcpServers":{}}']) {
    writeFileSync(file, edited);
    expect(() => undoEntry({ ...target, receiptDir })).toThrow(`${file}: managed entry changed since installation`);
    expect(readFileSync(file, "utf8")).toBe(edited);
    expect(readFileSync(applied.receipt, "utf8")).toBe(receiptBefore);
  }
});

test("an entry that already matches is not claimed", () => {
  const { file, receiptDir, target } = fixture();
  mkdirSync(dirname(file), { recursive: true });
  const before = '{"mcpServers":{"managed":{"command":"existing"}}}';
  writeFileSync(file, before);
  const plan = planEntry({ ...target, entry: { command: "existing" } });
  expect(applyEntry(plan, { receiptDir }).change).toBe("unchanged");
  expect(existsSync(receiptDir)).toBe(false);
  expect(undoEntry({ ...target, receiptDir }).change).toBe("unchanged");
  expect(readFileSync(file, "utf8")).toBe(before);
});
