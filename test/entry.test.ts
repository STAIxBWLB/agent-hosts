import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { applyEntry, EntryRefusal, planEntry, readEntryReceipt, realPath, REFUSAL_CODES, resolveHostPaths, SETUP_CONFIG_BYTES, undoEntry, UNDO_NOOP_CODES, type RefusalCode } from "@staix/agent-hosts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(host: "codex" | "kimi" | "jcode" | "opencode" = "kimi") {
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
  const again = undoEntry({ ...target, receiptDir });
  expect(again).toMatchObject({ change: "unchanged", code: "no-receipt" });
  expect(UNDO_NOOP_CODES).toContain(again.code!);
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

test("undo refuses a third-party replacement and acknowledges a removed entry", () => {
  const { file, receiptDir, target } = fixture();
  const applied = applyEntry(planEntry({ ...target, entry: { command: "ours" } }), { receiptDir });
  const receiptBefore = readFileSync(applied.receipt, "utf8");
  for (const edited of ['{"mcpServers":{"managed":{"command":"theirs"}}}', '{"mcpServers":{}}']) {
    writeFileSync(file, edited);
    if (edited.includes("theirs")) {
      expect(() => undoEntry({ ...target, receiptDir })).toThrow(`${file}: managed entry changed since installation`);
      expect(readFileSync(applied.receipt, "utf8")).toBe(receiptBefore);
    } else {
      expect(undoEntry({ ...target, receiptDir })).toMatchObject({ change: "unchanged", code: "entry-already-absent", intent: applied.intent });
      expect(existsSync(applied.receipt)).toBe(false);
    }
    expect(readFileSync(file, "utf8")).toBe(edited);
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

function assertRefusal(operation: () => unknown, code: RefusalCode, context: string): void {
  try {
    operation();
  } catch (error) {
    if (!(error instanceof EntryRefusal)) throw error;
    expect(error.code).toBe(code);
    expect(REFUSAL_CODES).toContain(error.code);
    expect(error.reason).toBe(error.message);
    expect(error.reason).toContain(context);
    return;
  }
  throw new Error(`expected ${code}`);
}

test("refusal codes are unique, stable kebab-case identifiers", () => {
  expect(new Set(REFUSAL_CODES).size).toBe(REFUSAL_CODES.length);
  for (const code of REFUSAL_CODES) expect(code).toMatch(/^[a-z]+(?:-[a-z]+)+$/);
});

test("plan and apply forward the selected host's path refusal", () => {
  const { target, receiptDir } = fixture("jcode");
  const paths = resolveHostPaths({ home: target.paths.home, env: { JCODE_HOME: "" } });
  const plan = planEntry({ ...target, paths, entry: { command: "fixture" } });
  expect(plan).toEqual({
    change: "refused", code: "empty-override",
    reason: "JCODE_HOME is set but empty; unset it or supply an absolute directory",
  });
  assertRefusal(() => applyEntry(plan, { receiptDir }), "empty-override", "JCODE_HOME");
  assertRefusal(() => undoEntry({ ...target, paths, receiptDir }), "empty-override", "JCODE_HOME");
  expect(existsSync(receiptDir)).toBe(false);
});

test.each([
  ["command", { command: '/fixture/${ROOT}/server', args: ["mcp"] }],
  ["args", { command: "/fixture/server", args: ["--config", '${ROOT}/config'] }],
] as const)("refuses Jcode interpolation in %s", (_, entry) => {
  const { file, target, receiptDir } = fixture("jcode");
  const plan = planEntry({ ...target, entry });
  expect(plan).toEqual({
    change: "refused", code: "jcode-interpolation", file,
    reason: file + ': Jcode interpolates ${ in a command or argument; remove the placeholder before applying',
  });
  assertRefusal(() => applyEntry(plan, { receiptDir }), "jcode-interpolation", file);
  expect(existsSync(file)).toBe(false);
});

const opencodeEntry = { type: "local", command: ["/fixture/server", "mcp"], enabled: true };

test.each(["OPENCODE_CONFIG", "OPENCODE_CONFIG_DIR", "OPENCODE_CONFIG_CONTENT"] as const)(
  "OpenCode refuses nonblank %s for plan and apply but allows undo",
  (variable) => {
    const { file, target, receiptDir } = fixture("opencode");
    const { home } = target.paths;
    const blank = resolveHostPaths({ home, env: { [variable]: "  \t " } });
    expect(blank.refusals).toEqual([]);
    const preview = planEntry({ ...target, paths: blank, entry: opencodeEntry });
    expect(applyEntry(preview, { receiptDir, env: {} }).change).toBe("add");

    const paths = resolveHostPaths({ home, env: { [variable]: "configured" } });
    expect(paths.paths.opencode).toEqual([file]);
    const reason = `${variable} routes OpenCode away from ${file}; unset it and resolve paths again before applying`;
    expect(paths.refusals).toEqual([{ host: "opencode", code: "opencode-config-route", variable, file, reason }]);
    const plan = planEntry({ ...target, paths, entry: opencodeEntry });
    expect(plan).toEqual({ change: "refused", code: "opencode-config-route", reason, file });
    assertRefusal(() => applyEntry(plan, { receiptDir }), "opencode-config-route", variable);
    expect(undoEntry({ ...target, paths, receiptDir }).change).toBe("removed");
    expect(existsSync(file)).toBe(false);
  },
);

test.each(["opencode.jsonc", "config.json"] as const)(
  "OpenCode refuses sibling %s at preview and apply, and leaves it alone during undo",
  (name) => {
    const { file, target, receiptDir } = fixture("opencode");
    const sibling = join(dirname(file), name);
    const initial = planEntry({ ...target, entry: opencodeEntry });
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(sibling, '{"thirdParty":true}');
    const refused = planEntry({ ...target, entry: opencodeEntry });
    expect(refused).toEqual({
      change: "refused", code: "opencode-merged-config", file,
      reason: `${sibling} is merged with ${file}; consolidate the configuration into opencode.json before applying`,
    });
    assertRefusal(() => applyEntry(initial, { receiptDir, env: {} }), "opencode-merged-config", sibling);
    expect(existsSync(file)).toBe(false);
    expect(existsSync(receiptDir)).toBe(false);
    rmSync(sibling);
    expect(applyEntry(initial, { receiptDir, env: {} }).change).toBe("add");
    writeFileSync(sibling, '{"thirdParty":true}');
    expect(undoEntry({ ...target, receiptDir }).change).toBe("removed");
    expect(readFileSync(sibling, "utf8")).toBe('{"thirdParty":true}');
  },
);

test("OpenCode apply rechecks refreshed routing and the captured plan policy", () => {
  const { file, target, receiptDir } = fixture("opencode");
  const preview = planEntry({ ...target, entry: opencodeEntry });
  if (preview.change === "refused") throw new Error(preview.reason);
  expect(preview.opencodeRoutes).toEqual([]);
  assertRefusal(() => applyEntry(preview, { receiptDir }), "opencode-environment-required", file);
  const variable = "OPENCODE_CONFIG_CONTENT";
  assertRefusal(
    () => applyEntry(preview, { receiptDir, env: { [variable]: '{"routing":true}' } }),
    "opencode-config-route", variable,
  );
  assertRefusal(
    () => applyEntry({ ...preview, opencodeRoutes: [variable] }, { receiptDir, env: {} }),
    "opencode-config-route", variable,
  );
  expect(existsSync(file)).toBe(false);
  expect(existsSync(receiptDir)).toBe(false);
});

test.each([
  ["kimi", '{"note":"', '"}'],
  ["codex", "# ", "\n"],
] as const)("preview refuses a %s after-image over the 8 MiB limit", (host, prefix, suffix) => {
  const { file, target, receiptDir } = fixture(host);
  mkdirSync(dirname(file), { recursive: true });
  const original = prefix + "x".repeat(SETUP_CONFIG_BYTES - prefix.length - suffix.length) + suffix;
  writeFileSync(file, original);
  const plan = planEntry({ ...target, entry: { command: "fixture", args: ["mcp"] } });
  expect(plan.change).toBe("refused");
  if (plan.change !== "refused") throw new Error("expected the result size to be refused");
  expect(plan.code).toBe("size-limit");
  expect(plan.reason).toContain(file);
  assertRefusal(() => applyEntry(plan, { receiptDir }), "size-limit", file);
  expect(readFileSync(file, "utf8")).toBe(original);
  expect(existsSync(receiptDir)).toBe(false);
});

test.each(["kimi", "codex"] as const)("explicit %s removal reports the current entry and remains undoable", (host) => {
  const { file, target, receiptDir } = fixture(host);
  const entry = { command: "existing", args: ["mcp"] };
  const before = host === "codex"
    ? '[mcp_servers.managed]\ncommand = "existing"\nargs = ["mcp"]\n\n[mcp_servers.other]\ncommand = "keep"\n'
    : '{"mcpServers":{"managed":{"command":"existing","args":["mcp"]},"other":{"command":"keep"}}}';
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, before);
  const plan = planEntry({ ...target, entry: null });
  if (plan.change !== "remove") throw new Error("expected a removal plan");
  expect(plan.current).toEqual(entry);
  const applied = applyEntry(plan, { receiptDir });
  expect(applied).toMatchObject({ change: "remove", intent: plan.intent });
  const receipt = readEntryReceipt({ ...target, receiptDir });
  expect(receipt).toEqual({ file, receipt: applied.receipt, intent: plan.intent, before: plan.before, after: plan.after });
  const after = readFileSync(file, "utf8");
  const absent = planEntry({ ...target, entry: null });
  expect(absent).toMatchObject({ change: "unchanged", current: undefined });
  expect(after).toContain("keep");
  expect(undoEntry({ ...target, receiptDir })).toMatchObject({ change: "restored", intent: plan.intent });
  expect(readFileSync(file, "utf8")).toBe(before);
});

test("undo of a user-deleted replacement keeps the current file and consumes the package receipt", () => {
  const { file, target, receiptDir } = fixture();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, '{"mcpServers":{"managed":{"command":"prior"}}}');
  const applied = applyEntry(planEntry({ ...target, entry: { command: "installed" } }), { receiptDir });
  const current = '{"mcpServers":{},"unrelated":true}';
  writeFileSync(file, current);
  const inode = statSync(file).ino;
  expect(undoEntry({ ...target, receiptDir })).toMatchObject({ change: "unchanged", code: "entry-already-absent", intent: applied.intent });
  expect(readFileSync(file, "utf8")).toBe(current);
  expect(statSync(file).ino).toBe(inode);
  expect(readEntryReceipt({ ...target, receiptDir })).toBeUndefined();
});

test("TOML undo drops a package-created empty MCP table while retaining later root edits", () => {
  const { file, target, receiptDir } = fixture("codex");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, 'title = "initial"\n');
  applyEntry(planEntry({ ...target, entry: { command: "fixture", args: ["mcp"] } }), { receiptDir });
  const installed = readFileSync(file, "utf8").replace('title = "initial"', 'title = "later"');
  writeFileSync(file, installed);
  expect(undoEntry({ ...target, receiptDir }).change).toBe("removed");
  expect(readFileSync(file, "utf8")).toBe('title = "later"\n');
});

test("JSON undo preserves a pre-existing MCP key after the user removes its other entry", () => {
  const { file, target, receiptDir } = fixture();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, '{"mcpServers":{"other":{"command":"old"}}}');
  applyEntry(planEntry({ ...target, entry: { command: "fixture" } }), { receiptDir });
  writeFileSync(file, '{"mcpServers":{"managed":{"command":"fixture"}},"later":true}');
  expect(undoEntry({ ...target, receiptDir }).change).toBe("removed");
  expect(readFileSync(file, "utf8")).toBe('{"mcpServers":{},"later":true}');
});

test("receipt lookup follows historical receipt names without reading the historical config", () => {
  const { file, target, receiptDir } = fixture();
  const historical = join(target.paths.home, "older", "mcp.json");
  const historicalPaths = { ...target.paths, paths: { ...target.paths.paths, kimi: [historical] } };
  const old = { ...target, paths: historicalPaths };
  const applied = applyEntry(planEntry({ ...old, entry: { command: "historical" } }), { receiptDir });
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, readFileSync(historical), { mode: 0o600 });
  target.paths.legacyPaths.kimi = [historical];
  expect(readEntryReceipt({ ...target, receiptDir })).toMatchObject({
    file: historical, receipt: applied.receipt, intent: applied.intent,
  });
  expect(undoEntry({ ...target, receiptDir }).change).toBe("removed");
  expect(existsSync(file)).toBe(false);
  expect(readFileSync(historical, "utf8")).toContain("historical");
});

test("JSON undo removes a package-created empty container and keeps later root fields", () => {
  const { file, target, receiptDir } = fixture();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, '{"original":true}');
  applyEntry(planEntry({ ...target, entry: { command: "fixture" } }), { receiptDir });
  writeFileSync(file, '{"original":true,"mcpServers":{"managed":{"command":"fixture"}},"later":true}');
  expect(undoEntry({ ...target, receiptDir }).change).toBe("removed");
  expect(readFileSync(file, "utf8")).toBe('{"original":true,"later":true}');
});
