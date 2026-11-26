import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { applyEntry, EntryRefusal, planEntry, realPath, REFUSAL_CODES, resolveHostPaths, SETUP_CONFIG_BYTES, undoEntry, UNDO_NOOP_CODES, type RefusalCode } from "@staix/agent-hosts";

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
    change: "refused", code: "jcode-interpolation",
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
    expect(applyEntry(preview, { receiptDir }).change).toBe("add");

    const paths = resolveHostPaths({ home, env: { [variable]: "configured" } });
    expect(paths.paths.opencode).toEqual([file]);
    const reason = `${variable} routes OpenCode away from ${file}; unset it and resolve paths again before applying`;
    expect(paths.refusals).toEqual([{ host: "opencode", code: "opencode-config-route", variable, file, reason }]);
    const plan = planEntry({ ...target, paths, entry: opencodeEntry });
    expect(plan).toEqual({ change: "refused", code: "opencode-config-route", reason });
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
      change: "refused", code: "opencode-merged-config",
      reason: `${sibling} is merged with ${file}; consolidate the configuration into opencode.json before applying`,
    });
    assertRefusal(() => applyEntry(initial, { receiptDir }), "opencode-merged-config", sibling);
    expect(existsSync(file)).toBe(false);
    expect(existsSync(receiptDir)).toBe(false);
    rmSync(sibling);
    expect(applyEntry(initial, { receiptDir }).change).toBe("add");
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
  const variable = "OPENCODE_CONFIG_CONTENT";
  assertRefusal(
    () => applyEntry(preview, { receiptDir, env: { [variable]: '{"routing":true}' } }),
    "opencode-config-route", variable,
  );
  assertRefusal(
    () => applyEntry({ ...preview, opencodeRoutes: [variable] }, { receiptDir }),
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
