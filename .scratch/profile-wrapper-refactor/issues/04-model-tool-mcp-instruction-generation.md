# 04: Per-profile generation of model, tools, MCP servers, and instructions

**What to build:**
Generators for the instance-specific configuration files:
- **Model**: If defined in the profile, writes `defaultProvider`, `defaultModel`, and `defaultThinkingLevel` to the instance `settings.json`.
- **Tools**: If defined in the profile, writes `defaultTools` to `settings.json` (e.g. read-only tools: `["read", "grep", "find", "ls"]`).
- **MCP Servers**: If `mcps` is declared in the profile, reads `~/.pi/agent/mcp.json` and outputs an instance `<agentDir>/mcp.json` keeping only the matching server configurations; if omitted, symlinks directly to `~/.pi/agent/mcp.json`.
- **Instructions**: If `instructions` is defined in the profile, writes the text to `<agentDir>/APPEND_SYSTEM.md`, which Pi natively appends to the system prompt; if undefined, removes any stale `APPEND_SYSTEM.md`.

**Blocked by:** 02: Full-fidelity symlink mirroring of `~/.pi/agent`

**Status:** ready-for-agent

- [ ] Generates `settings.json` with `defaultProvider`, `defaultModel`, and `defaultThinkingLevel` when specified by profile.
- [ ] Generates `settings.json` with `defaultTools` when specified by profile.
- [ ] Filters MCP servers from real `mcp.json` into instance `mcp.json` when `mcps` is declared.
- [ ] Preserves direct symlink to real `mcp.json` when profile declares no MCP restrictions.
- [ ] Writes profile instruction text into `<agentDir>/APPEND_SYSTEM.md`.
- [ ] Removes or avoids generating `APPEND_SYSTEM.md` when no instructions are defined.
- [ ] Unit tests verify generated JSON contents and instruction file writing across various profile definitions.
