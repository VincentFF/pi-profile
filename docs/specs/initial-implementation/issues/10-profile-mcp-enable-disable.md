# 10: Profile-scoped persistent /mcp enable|disable

**What to build:** Persistent, profile-scoped MCP toggles: `/mcp enable <server>` and `/mcp disable <server>` edit the active profile's `mcp` array in its owning catalog — through the locked adapter's profile-scoped state store, reached over the `pi.events` coordination channel — and then trigger an MCP-level runtime reload so the change is immediate. Enable accepts only adapter-discovered names; disable can also clean up stale references. The adapter's own configuration and default overlay are never modified.

**Blocked by:** 04 (pi-mcp-adapter coordination via pi.events), 05 (In-session switching, reload, and rollback)

**Status:** ready-for-agent

- [ ] `/mcp enable` accepts only names the adapter has discovered and fails fast on unknown names; `/mcp disable` can also remove names the adapter no longer reports.
- [ ] Both commands write the active profile's `mcp` array in that profile's owning catalog (via the adapter's profile-scoped state store) and then reload MCP, so the disabled server's tools leave the active set and the enabled server's tools rejoin it.
- [ ] Other profiles' `mcp` arrays are untouched; switching profiles restores each profile's own MCP selection.
- [ ] Neither command modifies the adapter's default `.pi/mcp.json` overlay or any connection configuration.
- [ ] With the adapter absent, both commands fail with a clear message.
