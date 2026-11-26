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
