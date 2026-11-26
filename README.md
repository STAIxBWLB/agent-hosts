# agent-hosts

`@staix/agent-hosts` resolves MCP configuration paths and previews, applies, or undoes one named server entry. It requires Bun 1.4.4 or later and has zero runtime dependencies.

Install an exact version after it is published.

```sh
bun add --exact @staix/agent-hosts@0.1.0
```

## Supported hosts

| Host ID | Default MCP files | Format | Verified versions |
| --- | --- | --- | --- |
| `claude` | user `~/.claude.json` | JSON `mcpServers` | `2.1.332` |
| `codex` | user `~/.codex/config.toml` | TOML `mcp_servers` | `0.165.0` |
| `kimi` | user `~/.kimi-code/mcp.json` / project `.kimi-code/mcp.json` | JSON `mcpServers` | `2.7.2` |
| `pi` | user `~/.pi/agent/mcp.json` | JSON `mcpServers` | `1.6.0` |
| `qwen` | user `~/.qwen/settings.json` | JSON `mcpServers` | `0.26.1` |
| `jcode` | user `~/.jcode/mcp.json` | JSON `servers` (alias `mcpServers`) | `0.99.1` |
| `opencode` | user `~/.config/opencode/opencode.json` | JSON `mcp` | `1.18.35` |
| `gemini` | user `~/.gemini/settings.json` | JSON `mcpServers` | `0.61.0` |

`HOSTS` records the file scopes, environment overrides, format, entry fields, and verified versions. `HostDefinition.entry` lists the minimum fields read by the host. Extra fields, including `env`, pass through. `CLAUDE_CONFIG_DIR` moves the Claude file into that directory as `.claude.json`. `QWEN_HOME` expands `~` against the injected home. A set but empty `JCODE_HOME` is refused. OpenCode and Gemini honor absolute `XDG_CONFIG_HOME` and `GEMINI_CLI_HOME` respectively, with an empty value treated as unset. [Version evidence](https://github.com/STAIxBWLB/agent-hosts/pull/5)

The direct workspace Antigravity (`agy`) configuration remains with each consumer for 0.1.0. See the [spec ruling](https://github.com/STAIxBWLB/agent-hosts/issues/1#antigravity-agy-is-not-in-010) and [fixture divergences](fixtures/DIVERGENCES.md).

## API

### Resolve and edit an MCP entry

```ts
import { applyEntry, planEntry, realPath, resolveHostPaths } from "@staix/agent-hosts";

const home = realPath("/path/to/home");
const paths = resolveHostPaths({ home, env: {}, hosts: ["codex"] });
const plan = planEntry({
  host: "codex",
  paths,
  name: "example",
  entry: { command: "/path/to/server", args: ["mcp"] },
});

if (plan.change === "refused") throw new Error(plan.reason);

// Inspect the plan before an explicit apply.
// applyEntry(plan, { receiptDir: `${home}/.example/setup` });
```

- `realPath(path)` resolves an existing physical path and throws for a missing path or dangling link. It handles Bun's backslash and symlink-parent edge cases.
- `resolveHostPaths({ env, home, workspaceRoot?, hosts?, scopes?, redirectManagedProfiles? })` returns `home`, per-host `paths`, pre-redirect `legacyPaths`, `redirects`, per-host `refusals`, and per-host `roots.current` and `roots.legacy` for locating sibling files such as hooks. Pass the environment and home explicitly. It selects user files by default. Supply `scopes: ["project"]` and `workspaceRoot` for Kimi's project file. Select exactly one file per host when calling the entry API. Managed Claude and Codex profiles redirect to the personal source by default. Set `redirectManagedProfiles: false` to keep the configured path. The resolver trims Claude, Codex, Kimi, and Pi overrides and omits files whose location override is invalid. Other hosts remain available.
- `planEntry({ host, paths, name, entry })` returns `add`, `replace`, `remove`, `unchanged`, or `refused` with a stable `code` and a human-readable `reason`. A successful preview contains the decoded `current` entry (or `undefined`), the before and after images, and an intent digest. Supply a plain JSON-compatible entry object or use `entry: null` to remove an entry with an undo receipt. Removing an absent entry is unchanged. Preview writes nothing.
- `applyEntry(plan, { receiptDir, env? })` rechecks file state and host policy under an exclusive lock, publishes the change, and records a versioned receipt. Use an absolute receipt directory. Generate a fresh plan if the file changed since preview. A matching entry with no receipt stays unclaimed. OpenCode requires fresh injected `env` on every apply. The plan carries routing-variable names without storing their values.
- `undoEntry({ host, paths, name, receiptDir })` restores the prior owned entry or removes the one it installed. A conflicting edit to the entry is left in place and the error names the file. The result identifies the config and receipt paths. If `legacy: true` is returned, the legacy receipt still exists and the consumer manages its cleanup. An unchanged undo carries a code from `UNDO_NOOP_CODES`. If someone deleted an installed entry, undo consumes its package receipt without restoring the prior entry. An explicit removal remains undoable.
- `readEntryReceipt({ host, paths, name, receiptDir })` reads the current or historical receipt without writing. It returns `file`, `receipt`, `intent`, `before`, `after`, and optional `pending` or `legacy`. Entry-only legacy formats yield synthesized MCP images because they store values rather than file snapshots.
- `REFUSAL_CODES` lists stable refusal identifiers used by both path and entry operations. Apply and undo throw `EntryRefusal` with a `code`, a human-readable `reason`, and `file` when a path is known. Refused plans also include `file` when known.
- `UNDO_NOOP_CODES` lists `no-receipt`, `entry-already-absent`, and `entry-already-restored` for unchanged undo results.

OpenCode preview and apply refuse nonblank `OPENCODE_CONFIG`, `OPENCODE_CONFIG_DIR`, or `OPENCODE_CONFIG_CONTENT` and sibling `opencode.jsonc` or `config.json` files. Undo remains available for the recorded global file. Jcode preview refuses `${` interpolation in the command or arguments.

Writes use bounded reads, refuse linked paths, and publish through a temporary file while preserving the config's mode. Configuration is capped at 8 MiB. The `<config>.agent-hosts.lock` file serializes package writers. Take any consumer-specific lock around package calls. If a stale lock blocks an operation, confirm that its writer has stopped before removing the named lock.

Package receipts use `entry-<digest([file, name])>.json` and carry version 1. A pending replacement can temporarily store its previous receipt at `<receipt>.previous-<digest>`. Consumers scanning the receipt directory should ignore these recovery files. Apply and undo return the receipt intent when one is known. Retry the same plan after interrupted publication. Undo can cancel a pending apply while the config still matches its start image. After publication, finish the apply before undoing.

### Use the codecs directly

| Export | Behavior |
| --- | --- |
| `createJsonMcpCodec(options)` | Returns synchronous `read(image)`, `put(image, value, options?)`, and `restore(before, after, current, options?)`. Supply `canonicalKey`, `entryName`, `label`, and optional `aliases` or `preferCanonical`. The latter selects the canonical container when a legacy file holds both. Use `undefined` to remove the value. Pass `keepEmpty: true` to retain an empty container or `ownedOnly: true` to restore lexically even when the entire current image equals the installed image. |
| `SETUP_CONFIG_BYTES` | Configuration limit in bytes, 8 MiB. |
| `setTomlPath(text, path, value, options?)` | Edits a string-keyed TOML subtree. `undefined` removes it. `refuseInlineParent: true` refuses edits that would rewrite a containing inline value. |
| `updateTomlArray(text, path, expectedArray)` | Appends or removes elements while retaining surviving syntax. Unsupported layouts, reordering, replacements, or mixed removal and append are refused. |
| `insertTomlArrayItems(text, path, expectedArray)` | Inserts restored rows without deleting, reordering, or reserializing surviving elements. |
| `restoreRemovedItems(before, after, current, key)` | Computes the array with rows removed by the installer reinserted beside surviving anchors. |

The JSON codec accepts strict JSON and keeps unrelated bytes. The TOML codecs use Bun's TOML parser and refuse a layout they cannot edit safely. Callers that use the raw-text TOML API can add the filename when surfacing errors.

### Exported types

| Type | Use |
| --- | --- |
| `HostId`, `HostScope` | Keys of `HOSTS` and the `user` or `project` scope. Pass a hub-owned path through the host's environment override. |
| `HostDefinition`, `HostConfig`, `HostFormat`, `HomeOverride` | Host metadata, per-file scope and path, JSON key or TOML table, and environment override rules. |
| `ResolveHostPathsOptions`, `HostPaths`, `HostRedirect`, `HostRefusal` | Resolver inputs, its path maps, managed-profile redirects, and path refusals. |
| `EntryTarget`, `PlanEntryOptions`, `ApplyEntryOptions` | Host, resolved paths, and name. Planning adds the desired `entry`. Apply takes a receipt directory and optional refreshed environment. |
| `EntryPlan`, `EntryResult`, `EntryReceipt` | Preview result, apply or undo result, and read-only receipt projection. |
| `RefusalCode`, `UndoNoopCode` | Machine-readable identifiers from `REFUSAL_CODES` and `UNDO_NOOP_CODES`. |
| `ConfigImage`, `JsonMcpCodecOptions` | Base64 `bytes` or `null` for an absent file, plus numeric `mode`, and the JSON codec's key and entry options. |

## Consumer migration

Use one PR per consumer and pin `@staix/agent-hosts` to the exact release. Keep the existing entry name and pass the consumer's existing setup directory as `receiptDir` so undo can find earlier receipts. Replay the [copy fixtures](fixtures/copies/) and [legacy receipts](fixtures/receipts/), and list behavior changes in the consumer PR. [Fixture divergences](fixtures/DIVERGENCES.md)

| Consumer | Migration |
| --- | --- |
| vault-mem | Pass entry name `vmem` and `<vault-mem home>/setup`. Remove the migrated host table and writers in the same PR. Keep the CLI output, console manifest, and Antigravity writer local. After a successful undo returning `legacy: true`, the consumer deletes the retained receipt. |
| agent-research | Pass `ares` and `<family home>/research/setup`. Remove the migrated host table and writers in the same PR. Keep the CLI output, console manifest, and Antigravity writer local. After a successful undo returning `legacy: true`, the consumer deletes the retained receipt. |
| agent-mem | Land the `@staix/agent-mem/platform` re-export of `realPath` first. Move MCP paths, lexical codecs, and entry handling to this package. Pass `amem` and `<memory home>/setup`. Keep hooks, the Pi extension, drift reports, writer roots, and the Antigravity writer local. Retain the prior journal when undo returns `legacy: true` because it also owns hook history. |
| agent-hub | Optionally adopt the path and format table after the other migrations if it removes duplicate code. Keep its project-scoped writers and adapter policy local. |

Vault-mem and agent-research gain Qwen tilde expansion and refuse an explicitly empty Jcode override. Both can disable managed-profile redirects to preserve their literal-path behavior. The package validates host overrides. When apply returns `legacy: true` and `supersedes`, the package receipt now owns the original baseline. Retire the superseded receipt after success. Agent-mem preserves any hook records it still needs before retiring a journal.

Treat export and entry result shapes, host metadata, and the version 1 receipt layout and location as the shared 0.1.0 protocol. Branch on refusal codes. Human-readable reasons may change in a patch. A new host or scope widens a closed union and requires a minor release with a changelog note. Newly verified versions and optional fields can be added in a patch. Later 0.x releases continue to read earlier 0.x receipts.

## Development and release

```sh
bun install --frozen-lockfile
bun run typecheck
bun test
bun scripts/check-pack.ts
```

CI runs tests with a temporary home. Tests inject fixture host paths and run offline. The npm tarball allowlist covers `src`, `fixtures`, `README.md`, `LICENSE`, and npm's required `package.json`.

The npm package owner registers `STAIxBWLB/agent-hosts` with workflow filename `release.yml` and enables direct publishing. Each tag requires the person's consent. The workflow publishes via npm OIDC after checking that the tag matches the manifest version and its commit belongs to `main`. [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/)
