# 07: In-session profile switching and status integration

**What to build:**
Commands available inside the active Pi session:
- `/profile use <name>`: Switch to a different profile in place. Updates the current instance's `settings.json`, `mcp.json`, and `APPEND_SYSTEM.md`, then calls Pi's native `ctx.reload()`. The session continues without interruption while extensions, skills, tools, and model are updated to match the new profile.
- `/profile list`: Lists available profiles from global and project catalogs, highlighting the currently active profile.
- `/profile status`: Shows the active profile name, loaded skills, enabled extensions, MCP server count, and model configuration.
- Footer badge: Displays the active profile name in the TUI footer status line.

**Blocked by:** 06: Thin wrapper CLI launcher and process forwarding

**Status:** resolved

- [ ] `/profile use <name>` validates that `<name>` exists in global or project catalogs.
- [ ] Rewrites the instance configuration files to match the new profile and invokes `ctx.reload()`.
- [ ] Verified that `ctx.reload()` preserves the active session history while applying the new resource configuration.
- [ ] `/profile list` formats and displays all discoverable profiles with active indicator.
- [ ] `/profile status` renders a concise overview of the profile's active capabilities and constraints.
- [ ] Profile name is visible in the status bar/footer badge during interactive sessions.
