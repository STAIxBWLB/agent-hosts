# Fixture divergences

| Copy | Case | Consumer result | Package result | Reason |
| --- | --- | --- | --- | --- |
| vault-mem | Antigravity (`agy`) | Writes and undoes the project MCP entry | Excluded from 0.1.0 | Project MCP shape lacks exact-version evidence, per #1 |
| agent-research | Antigravity (`agy`) | Writes and undoes the project MCP entry | Excluded from 0.1.0 | Project MCP shape lacks exact-version evidence, per #1 |
| agent-mem | Antigravity (`agy`) | Writes and undoes the project MCP entry | Excluded from 0.1.0 | Project MCP shape lacks exact-version evidence, per #1 |
| vault-mem | Legacy receipt undo | Deletes the consumed v1 receipt | Retains the legacy file | Legacy receipts remain with the consumer |
| agent-research | Legacy receipt undo | Deletes the consumed v1 receipt | Retains the legacy file | Legacy receipts remain with the consumer |
| agent-mem | Legacy receipt undo | Restores MCP and hook changes, then removes the journal | Restores the MCP entry and retains the journal | The consumer owns hook state and history |
| vault-mem and agent-research | Prior entry included as structured data or TOML fragment | Can reconstruct syntax using the old writer, which may re-render the document | Restores the prior entry lexically, preserving unrelated live bytes. Prior entry formatting can differ | The v1 receipt does not contain the original configuration image |
| vault-mem | `qwen-tilde-home` | Refuses a non-absolute `QWEN_HOME` | Expands `~/custom-qwen` under the injected home and installs there | Adopt agent-mem's Qwen override rule |
| agent-research | `qwen-tilde-home` | Refuses a non-absolute `QWEN_HOME` | Expands `~/custom-qwen` under the injected home and installs there | Adopt agent-mem's Qwen override rule |
| vault-mem | `jcode-empty-home` | Treats the empty override as unset and installs in `$HOME/.jcode/mcp.json` | Refuses the explicitly set empty override with `empty-override` | Match the Jcode host and agent-mem setup guard |
| agent-research | `jcode-empty-home` | Treats the empty override as unset and installs in `$HOME/.jcode/mcp.json` | Refuses the explicitly set empty override with `empty-override` | Match the Jcode host and agent-mem setup guard |
| vault-mem | All standard hosts, applied rendering | Pretty-prints JSON entries or emits a TOML table for the owned entry | Emits the owned JSON value compactly or uses the TOML codec's editable entry form | Keep unrelated bytes and use the shared lexical codecs |
| agent-research | All standard hosts, applied rendering | Pretty-prints JSON entries or emits a TOML table for the owned entry | Emits the owned JSON value compactly or uses the TOML codec's editable entry form | Keep unrelated bytes and use the shared lexical codecs |
| agent-mem | `claude-standard`, `kimi-standard`, `pi-standard`, `qwen-standard`, `gemini-standard`, applied rendering | Re-renders the JSON document | Emits the owned JSON value compactly | Keep unrelated bytes and use the shared lexical codec |
| agent-mem | `claude-standard`, `codex-standard`, `kimi-standard`, `pi-standard`, `jcode-standard` | Adds a separate hook or extension file and restores it on undo | Leaves the separate file untouched | Hook and extension ownership stays with the consumer |
| agent-mem | `qwen-standard` | Adds a hook in the MCP settings file and restores it on undo | Changes only the MCP entry in the shared file | Hook ownership stays with the consumer |
| agent-mem | Relative Claude, Codex, Kimi, Pi, or Qwen overrides after applicable trimming or tilde expansion | Resolves against its working directory | Refuses with `relative-override` | The shared resolver requires an absolute directory for each host |
| agent-mem | OpenCode sibling config during undo | Refuses a merged sibling configuration | Undoes the owned entry in the recorded `opencode.json` and preserves the sibling | The spec permits undo after a routing or layout change |
| agent-mem | Padded absolute Claude, Codex, Kimi, or Pi override | Checks trimmed presence and resolves the literal value | Resolves the trimmed absolute directory | Surrounding whitespace is ignored for these host overrides |
