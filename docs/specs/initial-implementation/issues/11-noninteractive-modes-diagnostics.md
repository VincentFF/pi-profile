# 11: Non-interactive modes and structured diagnostics

**What to build:** Non-interactive operation falls out of full passthrough: `pi-profile <profile> -- --mode rpc|print|json` launches the requested profile (or the saved one) with complete pre-start filtering, because mode handling is entirely native Pi. The remaining work is the boundary: the extension detects the current run mode and keeps interactive CRUD unavailable outside TUI mode, and RPC mode exposes structured, script-consumable profile status.

**Blocked by:** 05 (In-session switching, reload, and rollback), 08 (Resource-registry CRUD), 09 (Profile catalog CRUD), 10 (Profile-scoped persistent /mcp enable|disable)

**Status:** ready-for-agent

- [ ] RPC, print, and JSON modes start with the positional or saved profile and expose only that profile's resources from the first turn (integration: real subprocess per mode).
- [ ] None of the `/profile` CRUD commands or wizards are available outside TUI mode; attempting them fails cleanly with a mode-aware message.
- [ ] RPC mode can query structured profile status (active profile, source scope, resolved resources, MCP state) through a documented, script-consumable path.
- [ ] Arbitrary pi flags pass through unchanged in every mode, including session flags like `--continue` and `--no-session`.
