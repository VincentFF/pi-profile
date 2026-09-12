# 06: Runtime overlay customization and reset

**What to build:** The runtime overlay as the temporary-adjustment mechanism: `/profile customize` adjusts the active profile's skills, extensions, MCP servers, and tools for the current runtime only — written to runtime state, never to any catalog — and applied through the same rewrite-settings-and-reload path as a switch. Overlays cannot disable `alwaysOn` resources or their direct dependents, so safety gates survive experimentation. `/profile reset` discards the overlay and reactivates the profile exactly as declared.

**Blocked by:** 05 (In-session switching, reload, and rollback)

**Status:** ready-for-agent

- [ ] `/profile customize` changes take effect after reload, persist only in runtime state (never in catalog files), and do not outlive the runtime unless reapplied.
- [ ] Disabling an `alwaysOn` resource, or a resource in its dependency chain, via overlay is rejected at resolution time.
- [ ] One runtime holds exactly one active profile and at most one overlay; multi-profile stacking does not exist.
- [ ] `/profile reset` deletes the overlay and reactivates the profile definition exactly as declared (rewrite settings + reload).
- [ ] Unit coverage at the resolver boundary: overlay application, `alwaysOn` protection, and reset semantics.
