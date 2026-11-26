# Changelog

During 0.x, a breaking API change, receipt format change, or host path change is a minor release. Other changes are patches. Version 1.0.0 follows the vault-mem, agent-research, and agent-mem migrations. A host definition change also requires an exact pin update in each consumer.

## 0.1.0

### Added

- Verified MCP path and format metadata for eight hosts, including managed-profile redirects with historical paths.
- Read-only entry preview, guarded apply and undo, and versioned receipts with retry recovery.
- Lexical JSON and TOML codecs and the Bun-compatible `realPath` helper.
- MCP-only undo compatibility with vault-mem v1, agent-research v1, and agent-mem v1 and v2 receipts.
- Recorded setup fixtures and a consumer migration recipe.

### Consumer behavior changes

- Vault-mem and agent-research gain `QWEN_HOME` tilde expansion and explicit empty `JCODE_HOME` resolution.
- Antigravity's project writer stays with each consumer pending exact-version evidence. Other recorded behavior differences are documented in the [fixture divergence table](fixtures/DIVERGENCES.md).
