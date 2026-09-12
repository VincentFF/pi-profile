# 03: Project trust mirroring, project catalogs, and scope-aware state

**What to build:** Project-scope support built on trust mirroring: the resolver reads the real `trust.json` and is the sole gatekeeper for project resources (generated settings carry `defaultProjectTrust: "never"`, so Pi never auto-discovers project resources). Trusted projects get their selected resources additively included and their `.pi/settings.json` merged into the generated settings (project wins, nested key merge, per Pi's documented semantics). Project profiles and resource IDs with the same name fully replace global definitions; deleting a project override immediately reveals the global one. Runtime state writes go to the state file of the resolved profile's source scope.

**Blocked by:** 02 (Named global profiles via generated settings)

**Status:** ready-for-agent

- [ ] Project catalog, registry, resources, and state files are only read or written when the resolver's trust check passes; untrusted projects behave as if no project files exist, and their resources never enter generated settings.
- [ ] Trusted project: selected project resources (`.pi/skills`, `.pi/extensions`, ancestor `.agents/skills`) are additively included in generated settings; project `.pi/settings.json` content is merged into the generated settings per Pi's merge rules.
- [ ] `--approve` / `--no-approve` are consumed by the launcher as a one-run trust input to the resolver, never forwarded to Pi (integration: project resources stay filtered even when the user passes `--approve`).
- [ ] A project profile with the same name fully replaces the global definition (no merge); removing the project entry makes the global profile reappear immediately.
- [ ] Project resource-registry entries with the same ID override global entries and may add new IDs.
- [ ] Saving the active selection writes to the project state file for project-sourced profiles and the global state file for global-sourced profiles and `default`; the two scopes never overwrite each other.
