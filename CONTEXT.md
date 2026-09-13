# pi-profile

`pi-profile` is a Pi package that treats profiles as Pi's resource-selection mechanism: a profile references existing skills, extensions, configured MCP servers, and tools, and switches those references within a single running Pi instance.

## Language

**Profile**:
A named workflow definition that references resources and optionally declares model, thinking level, and instructions. Lives in the global or project catalog.
_Avoid_: preset, config

**default profile**:
The built-in, undeletable profile that loads Pi's full set of discoverable resources. Treated as global-sourced for state writes.

**Catalog**:
A `profiles.json` file holding profile definitions: `~/.pi/agent/profiles.json` (global) or `.pi/profiles.json` (project). A project profile with the same name fully replaces the global one; there is no inheritance.

**Source scope**:
Whether a profile came from the global or project catalog. Determines where runtime state and CRUD edits are written.

**RuntimeOverlay**:
A temporary adjustment to the active profile's resource and tool selections, usually called just "overlay". Never written to a catalog; `/profile reset` discards it.
_Avoid_: session profile, temporary profile

**Runtime state**:
The persisted active profile selection and overlay, written to the state file of the profile's source scope.

**ActivationPlan**:
The immutable, fully resolved set of skills, extensions, MCP servers, tools, and instructions produced from one profile plus one overlay. It is materialized as generated settings plus spawn flags (launch) or a settings rewrite plus native reload (in-session switch).

**Generated settings**:
The pi-profile-owned runtime directory holding a generated `settings.json` (the profile's resource selection encoded for Pi's native settings mechanism), symlinks to the user's real `trust.json`/`auth.json`/`models.json`/`models-store.json`/`npm/`, pointed at via `PI_CODING_AGENT_DIR`. Never a user configuration file; regenerated on every launch, switch, or reload.

**Runtime reload**:
Pi's native `ctx.reload()`: re-reads the settings file from disk, rebuilds resources, re-executes extensions, and preserves the session. The mechanism behind `/profile use`, `/profile reload`, overlay application, and rollback.

**Resource**:
Any capability a profile references: skill, extension, MCP server, or tool. Inside `resources.json` and `ResourceRegistry` specifically, an extension entry — either implicitly discovered (installed package entry, extensions-dir file) or an explicit override identified by a stable logical ID.

**SkillRegistry**:
The mapping from skill name to final `SKILL.md`, mirroring Pi's current full discovery result. Re-resolved on every start or reload.

**ResourceRegistry**:
The merged extension reference view (ADR-0006): implicit discovery (installed packages' `pi.extensions` entries, referenced by package name or source alias; loose files, referenced by filename stem) plus explicit `resources.json` overrides carrying `dependsOn` and `alwaysOn`. Explicit IDs win over same-ID implicit entries and may omit `entry` to inherit the discovered one. Project IDs override global ones. Registration is the override, never the prerequisite.

**McpServerRegistry**:
The MCP server names and states discovered by `pi-mcp-adapter`. Owned by the adapter; pi-profile only references server names.

**alwaysOn**:
A resource flag marking an extension that loads in every profile (e.g. a security gate or audit extension) and cannot be disabled by an overlay.

**pi-mcp-adapter**:
The optional external Pi package that owns MCP server configuration, connections, and credentials. pi-profile integrates with it but never stores MCP connection details in profiles.

**Project trust**:
Pi's trust decision for a project directory. pi-profile never reads or writes untrusted project directories. Because generated settings set `defaultProjectTrust: "never"`, the resolver is the sole gatekeeper: it reads the real `trust.json` and admits project resources only when trusted.
