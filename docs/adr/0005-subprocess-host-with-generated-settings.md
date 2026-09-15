# Subprocess host with per-profile generated Pi settings

Supersedes ADR-0001.

ADR-0001 concluded that Pi has no pre-start resource-filter seam, because the public Extension API offers none, and therefore the launcher must build the Pi runtime itself through the SDK. Spikes against Pi 0.85.1 disproved the premise: the seam exists, it is just not the Extension API. Pi's own settings mechanism filters resources before the first agent turn:

- Settings arrays (`skills`, `extensions`, `prompts`, `themes`) apply `!glob` exclusions and `-path` force-exclusions to auto-discovered resources (`~/.agents/skills` verified), and additive absolute paths re-include selected entries.
- Project-scope resources ignore global settings patterns, but `defaultProjectTrust: "never"` suppresses all project auto-discovery, after which additive absolute paths restore exactly the selected entries.
- `PI_CODING_AGENT_DIR` points Pi at a pi-profile-owned settings directory; symlinking sessions into the runtime directory keeps session storage in the real location with native directory structure. User configuration files are never modified.
- `ctx.reload()` re-reads the settings file from disk and rebuilds the runtime while preserving the session (sessionId, session file, and message history verified unchanged).

Decision: `pi-profile` spawns the real `pi` binary as a subprocess with the user's arguments passed through verbatim, a generated per-launch agent directory — a `settings.json` encoding the profile's resource selection plus symlinks to the user's real `trust.json`, `auth.json`, `models.json`, `models-store.json`, and `npm/` — and generated flags for tools and model. The pi-profile extension inside Pi orchestrates in-session profile switches by regenerating the settings file and calling `ctx.reload()`.

Filtering model: agentDir-scope resources become additive allowlists (the discovery root moves with the generated dir, so nothing is auto-discovered); `~/.agents` skills use exclusion patterns; project resources use `defaultProjectTrust: "never"` plus additive allowlists gated by the resolver's own `trust.json` check (pi-profile becomes the trust gatekeeper for project resources); packages use the object-form allowlist. Resource kinds pi-profile does not manage (prompt templates, themes, context files, Pi settings themselves) pass through untouched.

Consequences:

- All Pi CLI flags pass through natively; Pi's startup behavior (modes, changelog, updates, session resume) needs no re-implementation. The launcher only intercepts the positional profile name and `--approve` (which it reinterprets as trust input for profile resolution instead of letting Pi auto-discover project resources unfiltered).
- `ProfileHost`, `RuntimeApplier`, and `ResourceFilterAdapter` are deleted; the remaining core is domain logic (catalog, registries, resolver, state store) plus a settings generator.
- `/profile use` switches in-session without process restart via settings regeneration plus `ctx.reload()`; extensions re-execute on reload, so no stale extension context survives.
- Coupling moves from the SDK host API to Pi's settings schema, pattern semantics, env vars, and reload behavior (verified on 0.85.1; the integration suite spawns real Pi and guards drift).
- Known limitation: `pi install` / `pi config` inside a pi-profile session write the generated settings and are lost on exit; use `/profile edit` or plain `pi` for persistent package changes.

Evidence: throwaway spikes (fixture HOME, generated agent dir, real `pi --mode rpc` subprocess, RPC `get_commands` introspection, probe extension) verified every claim above; script preserved at the time in `/tmp/pi-profile-spike/`.
