export type HostScope = "user" | "project";

export interface HomeOverride {
  key: string;
  rule: "trim-presence" | "empty-means-set" | "expand-tilde" | "absolute-only";
  directory: string;
}

export interface HostConfig {
  scope: HostScope;
  path: string;
  override?: HomeOverride;
  defaultSiblingRoot?: string;
  routeVariables?: readonly string[];
  mergedFiles?: readonly string[];
  personalSource?: { profile: "claude" | "codex"; orcaHomeVariable: "ORCA_USER_DATA_PATH" };
}

export type HostFormat =
  | { kind: "json"; key: string; aliases?: readonly string[] }
  | { kind: "toml"; table: readonly string[] };

export interface HostDefinition {
  id: string;
  files: readonly HostConfig[];
  format: HostFormat;
  /** Minimum fields read by the host. Additional entry fields pass through. */
  entry: Readonly<Record<string, string>>;
  verified: readonly [string, ...string[]];
}

const stdio = { command: "string", args: "string[]" } as const;
const mcpServers = { kind: "json", key: "mcpServers" } as const;

export const HOSTS = {
  claude: {
    id: "claude",
    files: [{
      scope: "user",
      path: ".claude.json",
      defaultSiblingRoot: ".claude",
      override: { key: "CLAUDE_CONFIG_DIR", rule: "trim-presence", directory: "" },
      personalSource: { profile: "claude", orcaHomeVariable: "ORCA_USER_DATA_PATH" },
    }],
    format: mcpServers,
    entry: { ...stdio, type: "stdio", env: "Record<string, string>" },
    verified: ["2.1.332"],
  },
  codex: {
    id: "codex",
    files: [{
      scope: "user",
      path: "config.toml",
      override: { key: "CODEX_HOME", rule: "trim-presence", directory: ".codex" },
      personalSource: { profile: "codex", orcaHomeVariable: "ORCA_USER_DATA_PATH" },
    }],
    format: { kind: "toml", table: ["mcp_servers"] },
    entry: stdio,
    verified: ["0.165.0"],
  },
  kimi: {
    id: "kimi",
    files: [
      { scope: "user", path: "mcp.json", override: { key: "KIMI_CODE_HOME", rule: "trim-presence", directory: ".kimi-code" } },
      { scope: "project", path: ".kimi-code/mcp.json" },
    ],
    format: mcpServers,
    entry: stdio,
    verified: ["2.7.2"],
  },
  pi: {
    id: "pi",
    files: [{ scope: "user", path: "mcp.json", override: { key: "PI_CODING_AGENT_DIR", rule: "trim-presence", directory: ".pi/agent" } }],
    format: mcpServers,
    entry: stdio,
    verified: ["1.6.0"],
  },
  qwen: {
    id: "qwen",
    files: [{ scope: "user", path: "settings.json", override: { key: "QWEN_HOME", rule: "expand-tilde", directory: ".qwen" } }],
    format: mcpServers,
    entry: stdio,
    verified: ["0.26.1"],
  },
  jcode: {
    id: "jcode",
    files: [{ scope: "user", path: "mcp.json", override: { key: "JCODE_HOME", rule: "empty-means-set", directory: ".jcode" } }],
    format: { kind: "json", key: "servers", aliases: ["mcpServers"] },
    entry: { ...stdio, shared: "boolean" },
    verified: ["0.99.1"],
  },
  opencode: {
    id: "opencode",
    files: [{
      scope: "user",
      path: "opencode/opencode.json",
      override: { key: "XDG_CONFIG_HOME", rule: "absolute-only", directory: ".config" },
      routeVariables: ["OPENCODE_CONFIG", "OPENCODE_CONFIG_DIR", "OPENCODE_CONFIG_CONTENT"],
      mergedFiles: ["opencode.jsonc", "config.json"],
    }],
    format: { kind: "json", key: "mcp" },
    entry: { type: "local", command: "string[]", enabled: "boolean" },
    verified: ["1.18.35"],
  },
  gemini: {
    id: "gemini",
    files: [{ scope: "user", path: ".gemini/settings.json", override: { key: "GEMINI_CLI_HOME", rule: "absolute-only", directory: "" } }],
    format: mcpServers,
    entry: stdio,
    verified: ["0.61.0"],
  },
} as const satisfies Record<string, HostDefinition>;

export type HostId = keyof typeof HOSTS;
