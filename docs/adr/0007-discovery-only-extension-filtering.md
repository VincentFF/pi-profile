# Discovery-only extension filtering; removal of resources.json and ResourceRegistry

Supersedes ADR-0006.

## Context

ADR-0006 introduced auto-discovery for extensions (inspecting installed packages and extensions directories), but retained `resources.json` as an explicit override layer with `dependsOn` (dependency closures and cycle checks) and `alwaysOn` (immutable system extensions).

In practice, this retained unnecessary friction and architectural impedance mismatch:
- Pi itself has no extension dependency graph or always-on concept. Attempting to manage extension dependencies within `pi-profile` turned the switcher into an ad-hoc package manager, violating the principle of *Pi compatibility first* and *minimalism like Pi*.
- Maintaining two separate configuration surfaces (`profiles.json` and `resources.json`) and `/profile resource [list|create|edit|delete]` commands bloated the conceptual surface and CLI footprint.

## Decision

Completely retire `resources.json`, `resources.schema.json`, and `ResourceRegistry`. Adopt a pure **"Discover & Filter"** model for extensions, identical to how skills are handled:

1. **Native Discovery**: `ExtensionDiscovery` reads installed user packages (`package.json#pi.extensions`) and loose extension files (`<agentDir>/extensions/*.{ts,js}` and trusted project `.pi/extensions/*.{ts,js}`).
2. **Pure Profile Filtering**: Profiles declare extensions directly by package name, package source alias, multi-entry ID, filename stem, glob pattern, or absolute/home-relative file path. Resolution is a pure filter against discovered extensions without dependency closures or cycle checks.
3. **Overlays Without Gating**: Runtime overlays (`/profile customize -e <ext>`) can disable any resolved extension; `alwaysOn` restrictions are removed.
4. **Command Simplification**: The `/profile resource *` command family and its interactive wizards are deleted. `/profile` commands manage profiles exclusively.

## Consequences

- Configuration is radically simplified: `profiles.json` is the sole configuration file in `pi-profile`.
- Codebase size and complexity are reduced by eliminating the registry store, CRUD commands, dependency closure graph, and dual-file coordination.
- Zero behavior drift from native Pi: extensions are either active (included in generated settings) or inactive (excluded).
