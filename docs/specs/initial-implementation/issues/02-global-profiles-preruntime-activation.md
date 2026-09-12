# 02: Named global profiles via generated settings

**What to build:** Read named profiles from the global catalog and encode their resource selection into the generated settings before spawning Pi, so `pi-profile review` exposes only what `review` resolves — its skills, registered extensions (including `alwaysOn` resources and the `dependsOn` closure), and its tools — from the first agent turn. The SettingsGenerator emits the full filtering model: agentDir-scope allowlist paths, `~/.agents` exclusions, package object-form allowlists, `defaultProjectTrust: "never"`, and generated `--tools`/`--model` flags. Glob references re-expand at every start; optional model, thinking level, and instructions apply only when declared; activation failures are loud.

**Blocked by:** 01 (Package shell, passthrough launcher, and default profile)

**Status:** done

- [x] `pi-profile <name>` resolves the named global profile and spawns Pi with generated settings; integration (real `pi --mode rpc` + introspection) shows only the profile's resolved skills visible to the model and `/skill:`, and unselected extension code does not run.
- [x] Filtering model per scope: agentDir resources as additive allowlist paths, `~/.agents` skills excluded by pattern, packages filtered by object-form allowlist, `defaultProjectTrust: "never"` set for non-`default` profiles.
- [x] `dependsOn` closure joins the plan recursively, `alwaysOn` resources load in every profile, and cycles or missing entries/dependencies fail activation before spawn with a clear error.
- [x] Skill, extension-resource, and tool globs re-expand on every start; new matches enter the plan automatically.
- [x] Declared model becomes a generated `--model` flag; declared instructions are appended by the extension in `before_agent_start`; undeclared fields leave Pi's current model, thinking, and system prompt untouched.
- [x] A declared model that is missing or unauthenticated fails activation before spawn instead of running on an unexpected model.
- [x] Positional selection is transient (no state write); plain `pi-profile` restores the saved active profile from the global state file, falling back to `default`.

## Comments

**2026-09-12 — completed**

New modules: `profile-catalog.ts` (global `profiles.json`, `default` built-in and undeclarable), `resource-registry.ts` (global `resources.json`, recursive `dependsOn` closure with cycle/missing-entry/missing-dependency failures), `skill-registry.ts` (read-only `DefaultResourceLoader` discovery; extensions never execute; `PI_OFFLINE` forced during the load so missing packages are not installed as a resolution side effect), `profile-resolver.ts` (pure glob expansion + closure + `alwaysOn` + optional model/thinking/instructions), `runtime-state-store.ts` (global state read), `launcher/model-check.ts` + `launcher/discovery.ts`. `settings-generator.ts` gained the selection mode (additive paths, `~/.agents` `-path` exclusions, object-form package allowlists, `defaultProjectTrust: "never"`, `--tools`/`--model <provider/id[:thinking]>` flags, `pi-profile.json` launch plan for the extension); the extension appends declared instructions in `before_agent_start`.

Verification: `tsc --noEmit` clean; `vitest run` 106/106 across 15 files, including real-`pi --mode rpc` integration: only resolved skills visible in commands and system prompt, unselected/unregistered extension code never executes (side-effect markers absent), glob re-expansion across two launches, declared model+thinking visible via RPC `get_state`, unauthenticated declared model and dependency cycles exit before spawn with no runtime dir generated, positional launches write no state, user `settings.json` untouched.

Decisions made under ambiguity:
- A saved `activeProfile` that no longer exists in the catalog fails loudly (exit 2) instead of silently falling back to `default` — the user is told their saved preference is dangling rather than running with the wrong resource set.
- Model validation requires an exact provider/id match after Pi's own resolution; unlisted IDs under a known provider are accepted (Pi's custom-model-id fallback), matching native `--model` behavior.
- Tool globs expand against Pi's built-in tool names only; extension/MCP-provided tool names are unknowable without executing extension code, so literals pass through unvalidated and contributed-tool matching is deferred to the extension-side application (ticket 05+).
- Launcher discovery is offline/read-only; skills of a not-yet-installed package cannot be referenced until Pi installs it and a later reload re-resolves (ticket 05's `/profile reload`).
- Symlink group extended beyond ADR-0005's list with `git/` and `bin/` (package install root and Pi managed binaries, avoiding reinstalls into runtime dirs); `docs/architecture/overview.md` updated accordingly.

Not verified: interactive TUI smoke with real model auth (same caveat as ticket 01).
