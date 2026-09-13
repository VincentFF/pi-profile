# Profile-scoped MCP filtering: a generated overlay at the adapter's slot

[ADR-0002](0002-mcp-integration-locked-to-pi-mcp-adapter.md) locked MCP integration to `pi-mcp-adapter` and assumed the adapter would implement the runtime allowlist channel `pi-profile:mcp-allowlist:v1`. `pi-mcp-adapter@2.33.0` does not: it subscribes only to `pi-mcp-adapter:runtime-register:v1` and `pi-mcp-adapter:runtime-snapshot:v1`, and its status event exposes per-server `disabled` but no tool names. The published allowlist therefore had no runtime effect — switching profiles left every configured server's tools callable, and the only working lever was enumerating MCP tool names in `tools`, which is not workable at MCP scale.

## Context

- The adapter loads its servers from a fixed list of file sources, in this precedence order (later overrides earlier): the shared global MCP config (`~/.config/mcp/mcp.json`), `~/.agents/mcp.json` and `~/.agents/mcp/mcp.json`, the Pi-global slot (`--mcp-config <path>`, else `<agentDir>/mcp.json`), then the project's `.mcp.json` and `.pi/mcp.json` (project sources only when Pi reports the project trusted).
- Server merging is per-field (`merged[name] = { ...baseEntry, ...definition }`), and an entry only has to be an object to be valid. A source that writes `{ "<server>": { "disabled": true } }` therefore disables a server whose definition comes from any other source, without copying connection parameters or credentials. This is the adapter's own idiom for `/mcp disable`.
- `disabled` is enforced everywhere: disabled servers are not connected, register no direct or namespace tools, and gateway calls (`mcp`, `mcpScript`) are refused with `MCP server "X" is disabled`.
- The adapter has no runtime API to add or repoint a config path for an already-installed instance, and re-reads configuration only at extension load and at `session_start` (no file watching).

## Decision

A profile's `mcp` array is enforced by a **generated disable overlay** written to the adapter's Pi-global slot:

1. The generated file is `<agentDir>/mcp.json` — the slot the adapter reads by default. It carries a top-level marker key (`piProfileSwitch`) that the adapter ignores; a slot file without the marker is the user's own and is adopted before the first overwrite.
2. The user's own Pi-global servers live in the sidecar `<agentDir>/mcp.user.json`, which this package only writes when adopting a hand-written slot (its definitions, plus the slot's non-server keys, are moved there; overlay stubs are skipped). Servers elsewhere (`~/.config/mcp/mcp.json`, `.agents`, project files) stay untouched and are disabled by name through `{ disabled: true }` stubs.
3. `mcp` absent → the overlay is a pass-through (nothing disabled); `[]` → every discovered server is disabled; `["github", "git*"]` → everything else is disabled.
4. **Flag injection is impossible**: Pi rejects two extensions registering the same CLI flag (`resource-loader.js` → `detectExtensionConflicts`, fatal for the later extension), so pi-profile-switch cannot register `mcp-config` on the adapter's behalf. A user-supplied `--mcp-config` therefore disables management entirely: the package writes nothing and reports that the profile cannot filter MCP servers.
5. Generation happens at extension load (synchronous, before the adapter's first config read), is re-checked at `session_start` (trust is only known there; a difference is written and the user is asked to `/reload`, since an event handler cannot reload), and is repeated on every switch (`/profile use`, the picker, `/mcp enable|disable`, CRUD reactivation) followed by `ctx.waitForIdle()` and `ctx.reload()` — but only when the overlay bytes actually changed.
6. The mechanism is gated on adapter presence (Pi's npm package root, `-e` argv, settings `packages`, or the event-bus probe). Absent adapter → no flag, no file, no warning.
7. The `pi-profile:mcp-allowlist:v1` publication is kept as the compatibility path for an upstream implementation.

## Considered alternatives

- **Ask the user to pass `--mcp-config <generated>`**: rejected as user experience — the parameter is mandatory for the feature and would have to be maintained in a shell alias.
- **Integrate the adapter's SDK (`createMcpAdapter`)**: rejected — it creates a *second* adapter instance with a fixed config snapshot; the installed instance keeps exposing every server, and Pi has no public `unregisterTool` to retire the first one.
- **Write the stubs into the shared `~/.config/mcp/mcp.json`**: rejected — other MCP clients read that file, and stub entries without a transport could break them.
- **Wait for the upstream allowlist channel**: kept as the long-term path, but it does not exist in any published adapter version.

## Consequences

- `<agentDir>/mcp.json` becomes a generated artifact. Adding a Pi-global MCP server means editing `mcp.user.json` (or any of the adapter's other sources); copying the sidecar back over the slot and deleting it restores the pre-package layout.
- A profile switch that changes the MCP selection costs one runtime reload (every extension is re-initialized); a switch that does not change it stays in place, like every other profile field.
- Not covered: the adapter's opt-in host discovery (`~/.claude.json`, `~/.cursor/mcp.json`, …) and package/agent-plugin/Claude-plugin servers are not part of discovery, so they cannot be referenced by a profile; they are disabled only when a stub happens to match their name.
- `PI_MCP_CONFIG_MODE=exclusive` makes the adapter read only the explicit `--mcp-config` path, which turns management off (documented, and reported when a profile declares `mcp`).
- If the adapter ever implements the allowlist channel, the generation, the sidecar and the reload can be deleted without changing profile semantics or the test assertions that matter (the adapter's exposed/disabled server set).
