# Discovery-first extension references; resources.json as override-only

**Superseded by [ADR-0007](0007-discovery-only-extension-filtering.md)** (`resources.json` and the ResourceRegistry were retired entirely). Kept for history.

Profiles reference extensions by logical ID registered in `resources.json` — that was the model inherited from the initial design, on the premise that "Pi extensions have no uniform global name field". In practice this forced users to hand-write an absolute entry path into a second file before referencing any extension, including npm packages Pi itself had already installed and enumerated. The failure modes were poor: literal ID misses failed with unactionable errors, and zero-match globs failed silently.

The premise is only half true. Extension *entries* have no name field, but installed *packages* do: `pi packages` lists them by unique source string (`npm:pi-mcp-adapter`), and each package declares its extension entries in `package.json#pi.extensions`. Loose files in the standard extensions dirs (`<agentDir>/extensions`, trusted `.pi/extensions`) are equally discoverable. Skills already worked this way (SkillRegistry consumes Pi discovery read-only); extensions were asymmetric for no good reason.

Decision: discovery first, registration as override.

- Implicit discovery (new `extension-discovery.ts`, read-only, never executes extension code): configured user packages contribute their declared `pi.extensions` entries under the package name (single-entry) or `name:relative-path` IDs (multi-entry); loose files are selectable by filename stem. `npm:<name>` source strings act as aliases.
- `resources.json` merges over the implicit layer: same-ID explicit entries win, may omit `entry` to inherit the discovered one, and remain the only way to register extensions outside the standard locations or to attach `alwaysOn`/`dependsOn`.
- Reference resolution order for literals: registry ID → package name/alias → on-disk path (ad-hoc entry). Unknown literals fail with the discovered candidate list, a did-you-mean, and a minimal registration example. Zero-match globs are collected into `plan.unmatched` and surfaced as launch warnings and in `/profile status` (tool globs excepted: contributed tools are unknowable before spawn, so a warning could be wrong).
- ID collisions between a loose file and a package name resolve to the loose file with a recorded warning; the package stays selectable via its source alias.
- An entry-less override with no discovered match dangles instead of failing at load: non-`alwaysOn` ones warn and fail only when referenced (load-time failure would break unrelated profiles — the same deferral missing entry files already had); `alwaysOn` ones join every closure and fail closed, since a silently dropped safety gate is worse than a blocked activation.

Consequences:

- The common case needs zero configuration: `"extensions": ["pi-mcp-adapter"]` works when the package is installed. Entry paths are derived at resolution time, so npm reinstalls and home-dir moves no longer break registrations.
- The filtering model (ADR-0005) is untouched: package-origin entries are encoded into the settings `packages` object-form allowlist exactly as before; loose and ad-hoc path entries remain additive absolute paths.
- Explicit registries keep full expressive power (stable IDs, `alwaysOn`, `dependsOn`, overrides); existing `resources.json` files keep working unchanged.
- `/profile resource list` still shows explicit entries only; implicit discovery is visible through error guidance and `/profile status`. Merged listing is a documented follow-up.

Consistency with the repo's design principles (AGENTS.md): this rides Pi's native package metadata and directory conventions without changing any Pi behavior, and removes configuration ceremony in favor of discovery.
