# 11: Non-interactive modes and structured diagnostics

**What to build:** Non-interactive operation falls out of full passthrough: `pi-profile <profile> -- --mode rpc|print|json` launches the requested profile (or the saved one) with complete pre-start filtering, because mode handling is entirely native Pi. The remaining work is the boundary: the extension detects the current run mode and keeps interactive CRUD unavailable outside TUI mode, and RPC mode exposes structured, script-consumable profile status.

**Blocked by:** 05 (In-session switching, reload, and rollback), 08 (Resource-registry CRUD), 09 (Profile catalog CRUD), 10 (Profile-scoped persistent /mcp enable|disable)

**Status:** done

- [x] RPC, print, and JSON modes start with the positional or saved profile and expose only that profile's resources from the first turn (integration: real subprocess per mode).
- [x] None of the `/profile` CRUD commands or wizards are available outside TUI mode; attempting them fails cleanly with a mode-aware message.
- [x] RPC mode can query structured profile status (active profile, source scope, resolved resources, MCP state) through a documented, script-consumable path.
- [x] Arbitrary pi flags pass through unchanged in every mode, including session flags like `--continue` and `--no-session`.

## Comments

**2026-09-12 — completed**

Mode detection is native: `ctx.mode` (`tui|rpc|json|print`). CRUD (`/profile create|edit|delete|duplicate`, `/profile resource create|edit|delete`) is gated on `ctx.mode === "tui"` with a mode-aware refusal ("requires TUI mode (current mode: rpc)"). This supersedes the ticket-08/09 `hasUI` gate — note that RPC mode HAS dialog-capable UI, so hasUI was the wrong predicate for "TUI-only CRUD". Consequence for earlier tickets: the RPC-driven wizard integration tests were converted into refusal assertions (the wizard flows remain fully unit-tested at the command handler with a TUI-mode fake ctx; real-TUI acceptance is manual per the spec checklist). Switching (`use`/`reload`/`customize`/`reset`), `/mcp` toggles, and the read-only surfaces (`list`/`status`/selector) deliberately stay available in RPC.

Structured status path (documented in overview.md): `/profile list|status` ship `pi.sendMessage({customType: "pi-profile-switch", display: true, details})` — RPC consumers read the message events; `details` carries `{kind: "list", profiles}` or `{kind: "status", report}` (the full StatusReport: active profile + source, overlay, resolved absolute paths, MCP tri-state, delta, conflicts).

Per-mode launches (integration, real subprocess, offline): print mode exits 0 quietly; json mode emits the session event and exits 0; unknown profile exits 2 with a clear error in print mode too. Flag passthrough: `--continue`/`--no-session`/`--model` verbatim through arg parsing and spawn argv (unit) and end-to-end in print mode.

Surfaced tension (ticket wording wins): spec.md US#67's rationale says non-interactive runs stay read-only, but the spec's own integration seam requires `/mcp enable|disable` over RPC — toggles and switches stay available in RPC; only wizard CRUD is TUI-gated.

Verification: `tsc --noEmit` clean; `vitest run` 290/290 across 38 files. Review fixes: docblock CRUD bullet + details payload, indentation, dead helper, overview notes the /mcp RPC exception.
