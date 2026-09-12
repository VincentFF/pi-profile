# 02: Named global profiles via generated settings

**What to build:** Read named profiles from the global catalog and encode their resource selection into the generated settings before spawning Pi, so `pi-profile review` exposes only what `review` resolves — its skills, registered extensions (including `alwaysOn` resources and the `dependsOn` closure), and its tools — from the first agent turn. The SettingsGenerator emits the full filtering model: agentDir-scope allowlist paths, `~/.agents` exclusions, package object-form allowlists, `defaultProjectTrust: "never"`, and generated `--tools`/`--model` flags. Glob references re-expand at every start; optional model, thinking level, and instructions apply only when declared; activation failures are loud.

**Blocked by:** 01 (Package shell, passthrough launcher, and default profile)

**Status:** ready-for-agent

- [ ] `pi-profile <name>` resolves the named global profile and spawns Pi with generated settings; integration (real `pi --mode rpc` + introspection) shows only the profile's resolved skills visible to the model and `/skill:`, and unselected extension code does not run.
- [ ] Filtering model per scope: agentDir resources as additive allowlist paths, `~/.agents` skills excluded by pattern, packages filtered by object-form allowlist, `defaultProjectTrust: "never"` set for non-`default` profiles.
- [ ] `dependsOn` closure joins the plan recursively, `alwaysOn` resources load in every profile, and cycles or missing entries/dependencies fail activation before spawn with a clear error.
- [ ] Skill, extension-resource, and tool globs re-expand on every start; new matches enter the plan automatically.
- [ ] Declared model becomes a generated `--model` flag; declared instructions are appended by the extension in `before_agent_start`; undeclared fields leave Pi's current model, thinking, and system prompt untouched.
- [ ] A declared model that is missing or unauthenticated fails activation before spawn instead of running on an unexpected model.
- [ ] Positional selection is transient (no state write); plain `pi-profile` restores the saved active profile from the global state file, falling back to `default`.
