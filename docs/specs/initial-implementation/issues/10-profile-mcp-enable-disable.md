# 10: Profile-scoped persistent /mcp enable|disable

**What to build:** Persistent, profile-scoped MCP toggles: `/mcp enable <server>` and `/mcp disable <server>` edit the active profile's `mcp` array in its owning catalog — through the locked adapter's profile-scoped state store, reached over the `pi.events` coordination channel — and then trigger an MCP-level runtime reload so the change is immediate. Enable accepts only adapter-discovered names; disable can also clean up stale references. The adapter's own configuration and default overlay are never modified.

**Blocked by:** 04 (pi-mcp-adapter coordination via pi.events), 05 (In-session switching, reload, and rollback)

**Status:** done

- [x] `/mcp enable` accepts only names the adapter has discovered and fails fast on unknown names; `/mcp disable` can also remove names the adapter no longer reports.
- [x] Both commands write the active profile's `mcp` array in that profile's owning catalog (via the adapter's profile-scoped state store) and then reload MCP, so the disabled server's tools leave the active set and the enabled server's tools rejoin it.
- [x] Other profiles' `mcp` arrays are untouched; switching profiles restores each profile's own MCP selection.
- [x] Neither command modifies the adapter's default `.pi/mcp.json` overlay or any connection configuration.
- [x] With the adapter absent, both commands fail with a clear message.

## Comments

**2026-09-12 — completed** (review fixes: ADR-0002 amendment + overview contract line corrected, /mcp added to the extension responsibility inventory, untrusted-project write defense-in-depth, no-op toggles skip the reload)

Deviation from the ticket text (surfaced, per protocol): "the locked adapter's profile-scoped state store" does not exist — ticket 04's recon of pi-mcp-adapter@2.33.0 showed no allowlist or profile-state API; the adapter's event surface is register/snapshot only, with no enable/disable/reload event. The profile's `mcp` array in its owning catalog IS the profile-scoped persistent store (via ticket 09's ProfileCatalogStore), and "MCP-level runtime reload" is the standard rewrite-settings-and-reload path (the adapter re-initializes connections at session_start, where the new allowlist is republished over the ticket-04 channel). This is the ticket's intent — persistent, profile-scoped, immediate — through the contract pi-profile-switch actually owns.

Semantics (`src/switching/mcp-toggle.ts`): enable requires adapter discovery (fail fast on unknown names, listing what WAS discovered); disable removes present and stale names alike; no-op when the requested state already holds (file byte-untouched); the `mcp` key is dropped when the last server is disabled; the built-in default profile has no catalog entry → clear error pointing at `/profile create`. The extension registers `/mcp enable|disable <server>`: launch plan + adapter presence probe (clear failure when absent) → catalog edit → notify (pre-reload; post-reload contexts are stale) → `reloadCurrent` switch. Only profiles.json is written; adapter mcp.json files are byte-identical (integration-asserted).

Verification: `tsc --noEmit` clean; `vitest run` 288/288 across 37 files. Integration (real pi + fake adapter): enable appends + republished allowlist carries the new server after reload; disable shrinks it; switching to another profile restores its own selection; mcp.json untouched.
