# 05: In-session switching, reload, and rollback

**What to build:** The runtime switching core of the `/profile` command family: `/profile use <name>` validates the target, persists the selection by source scope, waits for the agent to be idle, snapshots the current generated settings, rewrites them for the new plan, and calls `ctx.reload()` — Pi's native reload re-reads the settings from disk, rebuilds resources, and preserves the session. After reload the extension re-applies the profile's tools/model/thinking against Pi's actual registrations and publishes the MCP allowlist; the next agent turn receives a profile-change summary. `/profile reload` re-discovers and re-resolves through the same path so shared-resource edits propagate. Failed activations restore the settings snapshot and reload again.

**Blocked by:** 03 (Project trust mirroring, project catalogs, and scope-aware state), 04 (pi-mcp-adapter coordination via pi.events)

**Status:** ready-for-agent

- [ ] `/profile use <name>` switches profiles without restarting the Pi process; integration (real subprocess) shows the same sessionId/session file and unchanged message history across the switch, and the next agent turn receives a change summary.
- [ ] Switching waits for agent idle before rewriting settings; a running turn is never torn down mid-flight.
- [ ] Successful activation records `lastVerifiedProfile` and saves the selection to the correct scope's state file.
- [ ] `/profile reload` re-runs discovery and resolution, then rewrites settings and reloads; an edited shared `SKILL.md` is picked up by every referencing profile without a process restart.
- [ ] Activation failure (bad reference, missing MCP server, unauthenticated model, reload error) restores the previous verified settings snapshot and reloads again; the runtime never sits half-switched.
- [ ] After reload, the extension re-applies active tools (per Pi's actual registrations), optional model/thinking, and instructions; no stale extension or command context survives (Pi re-executes extensions on reload).
