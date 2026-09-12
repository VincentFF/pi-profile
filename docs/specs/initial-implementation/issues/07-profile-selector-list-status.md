# 07: Profile selector, listing, and runtime status

**What to build:** The observability and interactive-selection surface: `/profile` opens the profile selector; `/profile list` shows built-in, global, and project profiles with the final winning source; `/profile status` shows the active plan, any overlay, resolved absolute resource paths, glob deltas since the last plan, MCP server state, and same-name conflicts with their actual load order and winner. Status data comes from the resolved plan and runtime state plus Pi's actual registrations (commands, tools) observable inside the extension.

**Blocked by:** 05 (In-session switching, reload, and rollback)

**Status:** done

- [x] `/profile` opens an interactive selector listing every visible profile with its source label; choosing one activates it through the switching path.
- [x] `/profile list` shows the built-in `default`, global, and project profiles and which definition wins for each name.
- [x] `/profile status` reports: active profile and source scope, overlay contents, resolved absolute `SKILL.md` path per skill, glob adds/removes versus the previous plan, and MCP enabled / discovered-but-disabled / missing server names.
- [x] Same-name tool or command conflicts never block activation; status shows the conflict, Pi's actual load order, and the final winner as registered in the running session.

## Comments

**2026-09-12 — completed**

Data surfaces: the launch plan file now carries `resolved` (absolute skill `SKILL.md` paths + extension entries, written by `writeRuntimeFiles`) and `previousResolved` (name sets carried across switches by the orchestrator) — status reports the ACTIVE plan, not a fresh re-resolution. `/profile status` = buildStatusReport(plan, overlay from the scope state store, fresh `discoverAdapterServerNames` under the same trust gate, `pi.getCommands()` + `pi.getAllTools()`): MCP tri-state (enabled / discovered-but-disabled / missing = declared but no longer discoverable), glob delta (added/removed, kind-prefixed names), conflicts. `/profile list` = `listProfiles` (trust-gated catalog load; project-shadows-global flagged via a global-only reload). Bare `/profile` = `ctx.ui.select` over `name [source] — label`, activating through the same switch path (`clearOverlay: true`); print mode falls back to the list. Both list and status ship via `pi.sendMessage({customType: "pi-profile", display: true})` so they render in TUI chat and stream as RPC session events.

Conflict reporting: Pi's load order is first-wins, so the registered entry IS the winner. Reported conflicts: a plan skill whose `skill:<name>` command is registered from a different path (shadowed) or absent (not loaded), and a plan tool whose registered winner is neither a pi builtin (`sourceInfo.source === "builtin"`) nor owned by a plan-selected extension. Detection is status-only; activation never blocks (spec story 15).

Verification: `tsc --noEmit` clean; `vitest run` 232/232 across 28 files. Integration (real pi): `/profile list` shows builtin/global/project with shadowing; `/profile status` shows resolved absolute paths + `disabled=[github]` tri-state and, after `/profile use impl`, `delta: +[skill:impl] -[skill:review]`. Review fixes applied: selector options carry labels (spec story 23), tool-conflict detection added, command description covers list/status, import ordering, overview tree connectors, dead docblock reference. Not covered: real-TUI selector acceptance is a manual checklist item (spec); selector-driven activation is unit-tested at the command handler.
