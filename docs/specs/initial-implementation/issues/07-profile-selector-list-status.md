# 07: Profile selector, listing, and runtime status

**What to build:** The observability and interactive-selection surface: `/profile` opens the profile selector; `/profile list` shows built-in, global, and project profiles with the final winning source; `/profile status` shows the active plan, any overlay, resolved absolute resource paths, glob deltas since the last plan, MCP server state, and same-name conflicts with their actual load order and winner. Status data comes from the resolved plan and runtime state plus Pi's actual registrations (commands, tools) observable inside the extension.

**Blocked by:** 05 (In-session switching, reload, and rollback)

**Status:** ready-for-agent

- [ ] `/profile` opens an interactive selector listing every visible profile with its source label; choosing one activates it through the switching path.
- [ ] `/profile list` shows the built-in `default`, global, and project profiles and which definition wins for each name.
- [ ] `/profile status` reports: active profile and source scope, overlay contents, resolved absolute `SKILL.md` path per skill, glob adds/removes versus the previous plan, and MCP enabled / discovered-but-disabled / missing server names.
- [ ] Same-name tool or command conflicts never block activation; status shows the conflict, Pi's actual load order, and the final winner as registered in the running session.
