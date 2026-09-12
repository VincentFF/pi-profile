# 03: Project trust mirroring, project catalogs, and scope-aware state

**What to build:** Project-scope support built on trust mirroring: the resolver reads the real `trust.json` and is the sole gatekeeper for project resources (generated settings carry `defaultProjectTrust: "never"`, so Pi never auto-discovers project resources). Trusted projects get their selected resources additively included and their `.pi/settings.json` merged into the generated settings (project wins, nested key merge, per Pi's documented semantics). Project profiles and resource IDs with the same name fully replace global definitions; deleting a project override immediately reveals the global one. Runtime state writes go to the state file of the resolved profile's source scope.

**Blocked by:** 02 (Named global profiles via generated settings)

**Status:** done

- [x] Project catalog, registry, resources, and state files are only read or written when the resolver's trust check passes; untrusted projects behave as if no project files exist, and their resources never enter generated settings.
- [x] Trusted project: selected project resources (`.pi/skills`, `.pi/extensions`, ancestor `.agents/skills`) are additively included in generated settings; project `.pi/settings.json` content is merged into the generated settings per Pi's merge rules.
- [x] `--approve` / `--no-approve` are consumed by the launcher as a one-run trust input to the resolver, never forwarded to Pi (integration: project resources stay filtered even when the user passes `--approve`).
- [x] A project profile with the same name fully replaces the global definition (no merge); removing the project entry makes the global profile reappear immediately.
- [x] Project resource-registry entries with the same ID override global entries and may add new IDs.
- [x] Saving the active selection writes to the project state file for project-sourced profiles and the global state file for global-sourced profiles and `default`; the two scopes never overwrite each other.

## Comments

**2026-09-12 — completed**

New: `project-trust.ts` (mirrors Pi's `resolveProjectTrusted` order: one-run `--approve`/`--no-approve` override → nearest-ancestor stored `trust.json` decision → user `defaultProjectTrust: "always"` → otherwise untrusted; "ask" never grants because the launcher has no trust UI). Catalog and registry take an optional `projectDir` (passed only when trusted); same-name/ID project entries fully replace global ones. Skill discovery honors trust and additionally excludes project-scoped package skills (their install root is the project's `.pi/npm`, which generated global-scope settings cannot reference — documented limitation). The generator merges a trusted project's `.pi/settings.json` into the base per Pi's deep-merge rule (project wins, nested objects merge), then the selection encoding replaces managed keys on top; selected project-scope skills are emitted before user-scope ones to preserve Pi's first-wins priority.

Key mechanism found while testing: a stored trust decision beats `defaultProjectTrust: "never"` inside Pi, so for named profiles `trust.json` is no longer symlinked into the runtime dir (the default profile keeps it for native behavior). The launcher's resolver reads the real `trust.json` directly and is the sole project-trust gatekeeper; additive user-scope settings paths bypass Pi's trust check, so selected project resources load without Pi-side trust. `--approve`/`--no-approve` are consumed by the launcher for named profiles (never forwarded); `default` keeps native re-application.

State restore precedence (underspecified in the ticket): when the project is trusted, the project state file's `activeProfile` wins over the global one — project scope is the more specific context, matching the project-overrides-global rule everywhere else. State writes remain ticket 05's (`/profile use`); the launcher never writes state.

Verification: `tsc --noEmit` clean; `vitest run` 142/142 across 17 files, including real-pi integration: untrusted project catalogs/skills/extensions never enter the runtime (side-effect marker absent), trusted project gets selected `.pi` resources + merged settings with `defaultProjectTrust: "never"` intact, `--approve` grants one-run trust with filtering still applied and no persisted trust decision, `--no-approve` overrides a stored entry, project same-name replacement at launch, project-state restore.
