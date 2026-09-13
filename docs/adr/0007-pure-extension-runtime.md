# Pure-extension runtime: profiles ride Pi's native discovery

Supersedes [ADR-0001](0001-launcher-based-initial-profile-selection.md) and [ADR-0005](0005-subprocess-host-with-generated-settings.md). Supersedes [ADR-0006](0006-discovery-first-extension-references.md). Amends [ADR-0002](0002-mcp-integration-locked-to-pi-mcp-adapter.md). [ADR-0003](0003-no-profile-inheritance.md) and [ADR-0004](0004-profiles-reference-shared-resources.md) stand.

## Context

ADR-0005 pointed `PI_CODING_AGENT_DIR` at a per-launch generated directory holding a generated `settings.json` and a fixed allowlist of symlinks (`auth.json`, `models.json`, `models-store.json`, `mcp.json`, `npm/`, `git/`, `bin/`). The agent directory is a shared namespace: Pi core and every installed extension derive configuration, state, context-file, and session paths from it. Two failures followed in production use:

- **Sessions.** The attempt to keep session storage native (`PI_CODING_AGENT_SESSION_DIR=<real>/sessions`) pins the session directory to the flat sessions root. Pi derives the per-project directory (`<sessionDir>/--<cwd>--/`) only when no explicit session directory is set. pi-profile sessions therefore land one level above native sessions, and the two are mutually invisible in `pi -r`, `pi -c`, and `/resume`. The environment variable also overrides a user's `sessionDir` setting, which native Pi honors.
- **Extension state.** Any agent-directory file outside the symlink allowlist disappears from the spawned process. `pi-plan-build.json`, `plans/`, `mcp-cache.json`, `web-push.json`, and Pi's global `AGENTS.md` were not linked: third-party configuration silently fell back to defaults, and Pi dropped the global context file. Extensions that save atomically (temporary file plus rename, as `pi-plan-build` does) would additionally replace a symlink inside the ephemeral launch directory, so their writes are lost at cleanup.

Repairing the allowlist into a full mirror of the agent directory keeps the host process, keeps a generated-settings surface coupled to Pi's settings schema, and still loses atomic-save writes.

## Decision

`pi-profile` is a plain Pi package with no host process. It installs like any other extension through `pi.extensions`. The launcher, `PI_CODING_AGENT_DIR`, `PI_CODING_AGENT_SESSION_DIR`, generated settings, symlinks, and per-launch runtime directories are removed. A profile controls five things:

- `instructions`: text appended to Pi's built system prompt.
- `model` and `thinkingLevel`: a session-start preset, applied only when neither the CLI nor the session history states an explicit choice.
- `skills`: prompt visibility. `before_agent_start` recomputes the `<available_skills>` section with Pi's exported `formatSkillsForPrompt` over the profile's selection and replaces it inside the chained system prompt. Every loaded skill stays registered, so `/skill:name` remains available to the user for unselected skills.
- `mcp`: a runtime server allowlist published to `pi-mcp-adapter` over the ADR-0002 event channel.
- `tools`: the active tool set, applied with `pi.setActiveTools` against the live registry.

Startup profile selection is the registered CLI flag `--profile <name>` (`pi.registerFlag`; Pi has no flag of that name, and its parser forwards unknown flags to registered extension flags). `/profile use` re-applies runtime state in place; the settings rewrite, `ctx.reload()`, and the rollback snapshot are removed.

Extensions are no longer a profile resource. Every installed extension loads in every profile.

A plain `pi` start applies the stored active profile; `pi --profile default` is the explicit native baseline.

## Considered alternatives

- **Mirror the agent directory instead of allowlisting symlinks.** Rejected: keeps the host process and the settings-generation coupling, and atomic-save extensions still lose writes.
- **Hard skill isolation via `--no-skills` plus `resources_discover`.** The extension API has no in-process skill removal (`ResourcesDiscoverResult` carries only additive paths), so this requires a launcher or a user-supplied process flag. It also makes unselected skills unusable by the user. Rejected in favour of model-visibility filtering, which needs no host and keeps every skill hand-invocable.
- **Keep the SDK host of ADR-0001.** Rejected by ADR-0005 and still rejected: it reimplements Pi startup instead of riding it.

## Consequences

- Sessions, extension configuration, packages, project trust, project discovery, and the global `AGENTS.md` are native, because the agent directory is native.
- All extensions load in all profiles. Unselected extension code always runs; profiles no longer express capability restriction at the extension layer.
- Skill selection is model visibility, not access control. Unselected skills stay loaded, stay listed in the user's `/skill:` menu, and stay callable by the user; the model cannot see them.
- Profile switching no longer rebuilds the runtime. `/profile use` becomes an immediate state application: no idle wait, no reload, no rollback snapshot, no launch-plan file.
- `resources.json`, `ResourceRegistry`, extension discovery, `dependsOn`, and `alwaysOn` are deleted, together with the `/profile resource` command family.
- The skills filter is coupled to Pi's prompt format. The filter recomputes the section with the same exported formatter Pi uses; when the original section is not found in the system prompt, the turn proceeds unfiltered and reports a warning. An integration test guards drift.
- Model and thinking application follows Pi's own explicit-choice precedence: `--model`/`--thinking` and a session's recorded model changes outrank the profile preset.
