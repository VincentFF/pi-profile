# 09: Profile catalog CRUD

**What to build:** TUI CRUD for profile catalogs: `/profile create` asks explicitly whether to write the global or project catalog; editors produce self-contained profile definitions (no inheritance, glob references allowed); editing the active profile reactivates it immediately after save (rewrite settings + reload); deleting the active profile requires choosing a replacement first; variants are made by copying a complete definition under a new name.

**Blocked by:** 03 (Project trust mirroring, project catalogs, and scope-aware state), 05 (In-session switching, reload, and rollback), 08 (Resource-registry CRUD)

**Status:** ready-for-agent

- [ ] `/profile create` prompts for global vs project scope before writing; the created profile is immediately usable and appears in `/profile list` with the correct source.
- [ ] Saved definitions are complete and self-contained; the editor has no inheritance concept (no `extends`, no merge, no array append).
- [ ] Saving an edit to the active profile rewrites settings and reloads immediately; edits to inactive profiles do not touch the runtime.
- [ ] `/profile delete` on the active profile requires selecting a replacement first; deleting a project override reveals the global profile of the same name.
- [ ] The wizard can duplicate an existing profile's full definition under a new name — the only variant mechanism.
- [ ] CRUD is available only in TUI mode.
