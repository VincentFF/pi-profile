# pi-profile-switch

`pi-profile-switch` is a Pi package that treats profiles as Pi's session-selection mechanism: a profile selects the prompt, model, model visibility of skills, MCP servers, and tools of a running Pi session, and switches that selection in place.

## Language

**Profile**:
A named workflow definition that references resources and optionally declares instructions and a model preset. Lives in the global or project catalog.
_Avoid_: preset, config

**default profile**:
The built-in, undeletable profile that declares nothing: no filtering, no tool change, no model change. Treated as global-sourced for state writes.

**Catalog**:
A `profiles.json` file holding profile definitions: `~/.pi/agent/profiles.json` (global) or `.pi/profiles.json` (project). A project profile with the same name fully replaces the global one; there is no inheritance.

**Source scope**:
Whether a profile came from the global or project catalog. Determines where runtime state and CRUD edits are written.

**RuntimeOverlay**:
A temporary adjustment to the active profile's skill visibility, MCP allowlist, and tools, usually called just "overlay". Never written to a catalog; `/profile reset` discards it, `/profile use` clears it. A stored overlay never outlives its runtime.

**Runtime state**:
The persisted active profile selection and overlay, written to the state file of the profile's source scope.

**Selection** (`ResolvedSelection`):
The immutable result of resolving one profile plus one overlay against Pi's live resources: skill visibility filter, MCP allowlist, active tools, instructions, model preset, and the warnings from resolution. Applying it is a separate step.
_Avoid_: ActivationPlan (retired with the host architecture)

**Skills visibility**:
A profile's `skills` references do not load or unload anything. They select which skills the MODEL sees in the system prompt's `<available_skills>` section. Every loaded skill stays registered and callable by the user through `/skill:name`.
_Avoid_: skill filtering if it implies unloading

**Activation**:
Applying a selection to the running Pi: model preset, active tools, MCP allowlist. A failed activation applies nothing.

**Profile badge**:
The footer status line `profile: <name>` — plus `*` when a runtime overlay is in effect — that names the active profile at a glance. Written only for an activation that succeeded, and absent for `default`, which declares nothing and must not change Pi's footer either.
_Avoid_: profile indicator, footer label

**pi-mcp-adapter**:
The optional external Pi package that owns MCP server configuration, connections, and credentials. pi-profile-switch integrates with it but never stores MCP connection details in profiles.

**Project trust**:
Pi's trust decision for a project directory (`ctx.isProjectTrusted()`). pi-profile-switch never reads an untrusted project's catalog or state files. Pi itself gates project-scoped resources.
