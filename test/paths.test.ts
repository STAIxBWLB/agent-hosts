import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { HOSTS, resolveHostPaths } from "@staix/agent-hosts";

const temporary: string[] = [];
afterEach(() => {
  for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true });
});

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), "agent-hosts-paths-"));
  temporary.push(root);
  return root;
}

test("resolves only the verified MCP files under the supplied home by default", () => {
  const home = scratch();
  const expected = {
    claude: [join(home, ".claude.json")],
    codex: [join(home, ".codex/config.toml")],
    kimi: [join(home, ".kimi-code/mcp.json")],
    pi: [join(home, ".pi/agent/mcp.json")],
    qwen: [join(home, ".qwen/settings.json")],
    jcode: [join(home, ".jcode/mcp.json")],
    opencode: [join(home, ".config/opencode/opencode.json")],
    gemini: [join(home, ".gemini/settings.json")],
  };
  expect(resolveHostPaths({ env: {}, home })).toEqual({
    home,
    paths: expected,
    legacyPaths: expected,
    redirects: [],
    refusals: [],
    roots: Object.fromEntries(Object.entries(expected).map(([host, [file]]) => {
      const root = host === "claude" ? join(home, ".claude") : dirname(file!);
      return [host, { current: [root], legacy: [root] }];
    })),
  });
  for (const [id, host] of Object.entries(HOSTS)) {
    expect<string>(host.id).toBe(id);
    expect(host.verified).not.toHaveLength(0);
  }
});

test("expands QWEN_HOME before requiring an absolute override", () => {
  const home = scratch();
  expect(resolveHostPaths({ env: { QWEN_HOME: "~/custom/qwen" }, home }).paths.qwen)
    .toEqual([join(home, "custom/qwen/settings.json")]);
  expect(resolveHostPaths({ env: { QWEN_HOME: "~" }, home }).paths.qwen).toEqual([join(home, "settings.json")]);
});

test("refuses an explicitly empty JCODE_HOME and uses the default if it is unset", () => {
  const home = scratch();
  const found = resolveHostPaths({ env: { JCODE_HOME: "" }, home });
  expect(found.paths.jcode).toBeUndefined();
  expect(found.legacyPaths.jcode).toBeUndefined();
  expect(found.refusals).toEqual([{
    host: "jcode", code: "empty-override", variable: "JCODE_HOME",
    reason: "JCODE_HOME is set but empty; unset it or supply an absolute directory",
  }]);
  expect(found.paths.kimi).toEqual([join(home, ".kimi-code/mcp.json")]);
  expect(resolveHostPaths({ env: {}, home }).paths.jcode).toEqual([join(home, ".jcode/mcp.json")]);
});

test.each([
  ["claude", "CLAUDE_CONFIG_DIR"], ["codex", "CODEX_HOME"], ["kimi", "KIMI_CODE_HOME"],
  ["pi", "PI_CODING_AGENT_DIR"], ["qwen", "QWEN_HOME"], ["jcode", "JCODE_HOME"],
  ["opencode", "XDG_CONFIG_HOME"], ["gemini", "GEMINI_CLI_HOME"],
] as const)("refuses a relative override for %s (%s) without blocking other hosts", (host, variable) => {
  const home = scratch();
  const found = resolveHostPaths({ home, env: { [variable]: "relative" } });
  expect(found.paths[host]).toBeUndefined();
  expect(found.legacyPaths[host]).toBeUndefined();
  expect(Object.keys(found.paths)).toHaveLength(Object.keys(HOSTS).length - 1);
  expect(found.refusals).toEqual([{
    host, code: "relative-override", variable,
    reason: `${variable} is relative; unset it or supply an absolute directory`,
  }]);
});

test("honors absolute OpenCode and Gemini roots and treats empty roots as unset", () => {
  const home = scratch(), xdg = join(home, "xdg"), gemini = join(home, "gemini");
  expect(resolveHostPaths({ env: { XDG_CONFIG_HOME: xdg, GEMINI_CLI_HOME: gemini }, home }).paths)
    .toMatchObject({ opencode: [join(xdg, "opencode/opencode.json")], gemini: [join(gemini, ".gemini/settings.json")] });
  const defaults = resolveHostPaths({ env: { XDG_CONFIG_HOME: "", GEMINI_CLI_HOME: "" }, home });
  expect(defaults.paths.opencode).toEqual([join(home, ".config/opencode/opencode.json")]);
  expect(defaults.paths.gemini).toEqual([join(home, ".gemini/settings.json")]);
  expect(defaults.refusals).toEqual([]);
});

test("uses injected environment values and treats whitespace-only trim-presence overrides as unset", () => {
  const home = scratch(), namedHome = scratch();
  const env = { HOME: namedHome, CLAUDE_CONFIG_DIR: "   ", PI_CODING_AGENT_DIR: join(namedHome, "custom/pi") };
  const { paths } = resolveHostPaths({ env, home, hosts: ["claude", "pi"] });
  expect(paths).toEqual({ claude: [join(home, ".claude.json")], pi: [join(home, "custom/pi/mcp.json")] });
});

test.each(["codex-accounts/example/home", "codex-runtime-home/home"])(
  "redirects managed profiles while retaining the legacy paths (%s)",
  (codexLayout) => {
    const home = scratch();
    const orca = join(home, "custom-orca");
    const claudeProfile = join(orca, "claude-profiles/example/home");
    const codexProfile = join(orca, codexLayout);
    mkdirSync(claudeProfile, { recursive: true });
    mkdirSync(codexProfile, { recursive: true });
    const claudeAlias = join(home, "claude-alias");
    symlinkSync(claudeProfile, claudeAlias, "dir");
    const env = { ORCA_USER_DATA_PATH: ` ${orca} `, CLAUDE_CONFIG_DIR: claudeAlias, CODEX_HOME: codexProfile };
    const hosts = ["claude", "codex"] as const;
    const { paths, legacyPaths, redirects, roots } = resolveHostPaths({ env, home, hosts });
    expect(paths).toEqual({ claude: [join(home, ".claude.json")], codex: [join(home, ".codex/config.toml")] });
    expect(roots).toEqual({
      claude: { current: [join(home, ".claude")], legacy: [claudeAlias] },
      codex: { current: [join(home, ".codex")], legacy: [codexProfile] },
    });
    expect(legacyPaths).toEqual({ claude: [join(claudeAlias, ".claude.json")], codex: [join(codexProfile, "config.toml")] });
    expect(redirects).toEqual([
      { target: "claude", from: join(claudeAlias, ".claude.json"), to: join(home, ".claude.json"), reason: "Orca re-syncs this managed file from the personal source" },
      { target: "codex", from: join(codexProfile, "config.toml"), to: join(home, ".codex/config.toml"), reason: "Orca re-syncs this managed file from the personal source" },
    ]);
    expect(resolveHostPaths({ env, home, hosts, redirectManagedProfiles: false })).toEqual({
      home, paths: legacyPaths, legacyPaths, redirects: [], refusals: [],
      roots: {
        claude: { current: [claudeAlias], legacy: [claudeAlias] },
        codex: { current: [codexProfile], legacy: [codexProfile] },
      },
    });
  },
);

test("selects the project file only when its scope and workspace root are supplied", () => {
  const home = scratch(), workspaceRoot = scratch();
  const hosts = ["kimi"] as const, scopes = ["project"] as const;
  const options = { env: {}, home, hosts, scopes };
  expect(resolveHostPaths(options).paths).toEqual({ kimi: [] });
  expect(resolveHostPaths({ ...options, workspaceRoot }).paths).toEqual({ kimi: [join(workspaceRoot, ".kimi-code/mcp.json")] });
});

test.each([
  ["claude", "CLAUDE_CONFIG_DIR", ".claude.json"],
  ["codex", "CODEX_HOME", "config.toml"],
  ["kimi", "KIMI_CODE_HOME", "mcp.json"],
  ["pi", "PI_CODING_AGENT_DIR", "mcp.json"],
] as const)("trims %s overrides before resolving a nonblank value", (host, variable, filename) => {
  const home = scratch(), absolute = join(home, "custom");
  const padded = resolveHostPaths({ home, env: { [variable]: `  ${absolute}  ` } });
  expect(padded.paths[host]).toEqual([join(absolute, filename)]);
  expect(padded.refusals).toEqual([]);
  const blank = resolveHostPaths({ home, env: { [variable]: " \t " } });
  expect(blank.paths[host]).toEqual(resolveHostPaths({ home, env: {} }).paths[host]);
  expect(blank.refusals).toEqual([]);
});
