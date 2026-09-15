# 01: Relocate workspace and instance management to `~/.pi-profile-switch`

**What to build:**
Establish `~/.pi-profile-switch` as the dedicated root directory for all profile configurations, catalogs, and instance workspaces. Profile catalogs are read from `~/.pi-profile-switch/profiles.json` (falling back gracefully to `~/.pi/agent/profiles.json` if found). All profile instance directories are created under `~/.pi-profile-switch/instances/<profile-name>/agent`. No runtime state or instance directories are created or written inside `~/.pi`.

**Blocked by:** None (can start immediately)

**Status:** resolved

- [ ] Resolves global workspace directory to `~/.pi-profile-switch` (honoring custom test environment root overrides if configured).
- [ ] Global profile catalog loads from `~/.pi-profile-switch/profiles.json`, falling back to `~/.pi/agent/profiles.json` if the former does not exist.
- [ ] Project-level profile catalogs continue to load from `.pi/profiles.json` in trusted project directories.
- [ ] Instance directories are rooted under `~/.pi-profile-switch/instances/<profile-name>/`.
- [ ] Zero temporary runtime directories, state files, or instances are written into `~/.pi`.
- [ ] Unit tests verify workspace path resolution, catalog fallback loading, and directory isolation.
