# 04: pi-mcp-adapter coordination via pi.events

**What to build:** MCP support through in-Pi coordination: the pi-profile extension detects the locked `pi-mcp-adapter`, validates the profile's `mcp` references against adapter-discovered server names, and publishes the profile's runtime server allowlist over the `pi.events` event bus at activation (session start and after every reload). When the adapter is absent, profiles without `mcp` activate normally while profiles declaring `mcp` fail with a clear missing-adapter error. pi-profile never stores or manages MCP connection configuration, credentials, or the adapter's own enable/disable state.

**Blocked by:** 02 (Named global profiles via generated settings)

**Status:** done

- [x] Adapter presence is detected at activation; a profile declaring `mcp` fails loudly when the adapter is absent, while a profile without `mcp` activates unchanged and publishes no coordination.
- [x] Profile MCP names are validated against adapter-discovered servers; a referenced-but-undiscovered name fails activation before spawn (launch) or before reload (switch).
- [x] The runtime allowlist is applied in memory via the event bus on session start and after every `ctx.reload()`; the adapter's persistent enable/disable storage (its default `.pi/mcp.json` overlay) is never written by profile activation.
- [x] The built-in `default` profile without an `mcp` declaration uses the adapter's currently discovered and enabled servers in full.
- [x] Unit tests cover detection, allowlist publication, and both failure modes against a fake event bus / adapter.

## Comments

**2026-09-12 — completed**

Key recon outcome: pi-mcp-adapter is a real npm package (v2.33.0 inspected) with NO in-memory allowlist mechanism and no profile-scoped state store — the "locked version" of ADR-0002 does not exist yet. pi-profile therefore defines the coordination contract (`src/mcp-coordination.ts`): the versioned channel `pi-profile:mcp-allowlist:v1` (`{version, profile, servers}`) that the future locked adapter subscribes to, plus a presence probe reusing the adapter's documented request/result event pattern (`pi-mcp-adapter:runtime-snapshot:v1` with a bogus name; an installed adapter fills `result` synchronously, an absent one leaves it undefined).

Two-layer enforcement: the LAUNCHER fails before spawn when a profile declares `mcp` but no active extension's path contains "pi-mcp-adapter" (heuristic; plan entries carry no package source), and the EXTENSION re-probes at session start and throws + notifies when the adapter fails to answer (covers a selected-but-broken adapter). Name validation happens pre-spawn in the resolver against server names read from the adapter's pi-native config files (global `<agentDir>/mcp.json` + trusted project's `.pi/mcp.json`, names only — connection config never touched). Documented limitation: servers defined only in the adapter's editor-specific legacy locations (~/.claude/mcp.json etc.) are invisible to launch validation and such references fail; no in-session re-validation exists (adapter status snapshots arrive post-init).

`mcp` references support globs like other kinds (expand against discovered names; literals must exist). The generator now symlinks the adapter's global `mcp.json` into the runtime dir (its config path derives from `PI_CODING_AGENT_DIR`) and carries `mcp` in the launch plan file for the extension. Also in this ticket: launcher usage/selection failures (unknown profile, ActivationError, MissingMcpAdapterError, malformed catalogs/configs) uniformly exit 2 now — previously some exited 1.

Switch-side re-validation and re-publish ride on `ctx.reload()` (ticket 05): Pi re-fires `session_start` on reload, so the same handler re-publishes after every switch without extra wiring.

Verification: `tsc --noEmit` clean; `vitest run` 169/169 across 20 files. Integration (real pi, fake adapter extension): mcp declared + adapter absent → exit 2 pre-spawn; unknown mcp name → exit 2 pre-spawn; adapter present → allowlist published at session start with global mcp.json byte-identical and no project overlay created; profile without mcp → zero coordination. Review fixes applied: honest docblock (no phantom backstop), dead source-branch removed from the presence heuristic, error messages carry file paths, shared fake event bus helper.
