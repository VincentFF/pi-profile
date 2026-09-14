# 02: Full-fidelity symlink mirroring of `~/.pi/agent`

**What to build:**
An instance materializer that creates a complete symbolic mirror of the user's real `~/.pi/agent` inside `~/.pi-profile-switch/instances/<profile-name>/agent`. Every existing file and directory (such as `auth.json`, `models.json`, `models-store.json`, `trust.json`, `npm`, `git`, `bin`, `prompts`, `skills`, `agents`, `workflows`, `agent-memory`, `subagents.json`, extension cache files) is symlinked back to `~/.pi/agent`. Only files explicitly managed by the profile (`settings.json`, `mcp.json`, `APPEND_SYSTEM.md`) are excluded from auto-symlinking. Launch-time re-syncing ensures that newly installed native packages or models are immediately available in the profile instance.

**Blocked by:** 01: Relocate workspace and instance management to `~/.pi-profile-switch`

**Status:** ready-for-agent

- [ ] Inspects `~/.pi/agent` dynamically via directory scan instead of relying on a hardcoded file list.
- [ ] Creates symlinks for all files and directories in `~/.pi/agent`, correctly handling both file symlinks and directory symlinks.
- [ ] Excludes `settings.json`, `mcp.json`, and `APPEND_SYSTEM.md` from auto-symlinking so they can be independently generated.
- [ ] Detects and creates symlinks for newly added files/directories in `~/.pi/agent` on subsequent instance launches.
- [ ] Cleans up broken or dangling symlinks in the instance directory.
- [ ] Integration test verifies that third-party extension files (e.g. `agents/`, `workflows/`, `subagents.json`) exist and resolve to real targets within the instance.
