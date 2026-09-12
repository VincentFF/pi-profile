# 05: In-session switching, reload, and rollback

**What to build:** The runtime switching core of the `/profile` command family: `/profile use <name>` validates the target, persists the selection by source scope, waits for the agent to be idle, snapshots the current generated settings, rewrites them for the new plan, and calls `ctx.reload()` — Pi's native reload re-reads the settings from disk, rebuilds resources, and preserves the session. After reload the extension re-applies the profile's tools/model/thinking against Pi's actual registrations and publishes the MCP allowlist; the next agent turn receives a profile-change summary. `/profile reload` re-discovers and re-resolves through the same path so shared-resource edits propagate. Failed activations restore the settings snapshot and reload again.

**Blocked by:** 03 (Project trust mirroring, project catalogs, and scope-aware state), 04 (pi-mcp-adapter coordination via pi.events)

**Status:** done

- [x] `/profile use <name>` switches profiles without restarting the Pi process; integration (real subprocess) shows the same sessionId/session file and unchanged message history across the switch, and the next agent turn receives a change summary.
- [x] Switching waits for agent idle before rewriting settings; a running turn is never torn down mid-flight.
- [x] Successful activation records `lastVerifiedProfile` and saves the selection to the correct scope's state file.
- [x] `/profile reload` re-runs discovery and resolution, then rewrites settings and reloads; an edited shared `SKILL.md` is picked up by every referencing profile without a process restart.
- [x] Activation failure (bad reference, missing MCP server, unauthenticated model, reload error) restores the previous verified settings snapshot and reloads again; the runtime never sits half-switched.
- [x] After reload, the extension re-applies active tools (per Pi's actual registrations), optional model/thinking, and instructions; no stale extension or command context survives (Pi re-executes extensions on reload).

## Comments

**2026-09-12 — completed**

Architecture: the switch orchestrator (`src/switching/switch-profile.ts`) runs in-pi via the extension's `/profile` command, reusing the launcher's full resolution path (`resolveInitialProfile`) against the REAL agent dir (carried in the launch plan file as `agentDir`). The generator gained `writeRuntimeFiles` — rewriting settings.json + pi-profile.json inside the existing runtime dir (the running process's `PI_CODING_AGENT_DIR` cannot move) and transitioning the trust.json symlink for default↔named switches. Post-reload application (`src/switching/apply-plan.ts`) runs in the NEW extension instance at `session_start` (Pi re-executes extension modules on reload): raw tool references re-expand against Pi's LIVE registry (`tool-references.ts`, includes extension tools the pre-spawn expansion can't know), model/thinking applied, MCP allowlist re-published, and — gated on the `persistSelection` plan marker — state written to the scope-correct file (project source → `.pi/pi-profile-state.json`, else global).

Key mechanism decisions:
- State is written ONLY by the post-reload instance (never by the switcher, never by the launcher): a reload that fails before `session_start` leaves the state pointing at the last verified profile, so the next launch self-heals. `activeProfile` = `lastVerifiedProfile` on success.
- Interactive Pi swallows reload refusals/failures (showError, no rejection), so a resolved `ctx.reload()` is not proof: the switch verifies via a staleness probe (a real reload invalidates the old extension context; property access then throws). Silent skips take the same rollback path as rejections: restore the in-memory snapshot, reload again.
- The change summary travels via a `switchedFrom` marker in the plan file, cleared after one injection (one-shot across later reloads). `/profile reload` re-resolves WITHOUT the marker and preserves the current persistence mode — launch-transient selections stay transient.
- Idle waiting uses Pi's native `ctx.waitForIdle()`.

Documented limitations: a launch-time `--approve` one-run trust does not carry into the session — switching to a project profile in-session requires a stored trust decision. Post-reload application failures that surface only in the new instance's `session_start` (e.g. a selected adapter that failed to load) don't auto-rollback the files; the unchanged `lastVerifiedProfile` anchor covers the next launch. Summary injection is unit-tested at the `before_agent_start` seam; no integration assertion (offline fixture runs no real model turn).

Verification: `tsc --noEmit` clean; `vitest run` 197/197 across 21 files. Integration (real pi subprocess): switch keeps sessionId/sessionFile/messageCount while resources swap and state persists; `/profile reload` picks up an edited shared SKILL.md; a failed switch leaves runtime and state untouched. Review fixes applied: ENOENT-only tolerance in snapshot reads, loud failure when the plan carries no real agent dir, silent-reload rollback, deduped command handler, unified plan-file reader, honest surface types, architecture doc's switch-order updated.
