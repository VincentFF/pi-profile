# Spec: Remove Resource Registry in Favor of Native Extension Discovery and Filtering

Status: done

## Problem Statement

In `pi-profile`, extensions were historically managed through an explicit "Resource Registry" (`resources.json`, `resources.schema.json`, and `/profile resource` commands). This design originated from an early assumption that Pi extensions lacked uniform discoverability and required user-assigned logical IDs and manual absolute path mappings.

Although auto-discovery was later introduced, `resources.json` was retained as an explicit override layer, bringing with it complex concepts such as `dependsOn` (dependency closures, cycle detection, topological sorting) and `alwaysOn` (mandatory extensions protected from overlays).

This introduces significant problems:
1. **Mental Overhead and Conceptual Complexity**: Users must understand and maintain two separate registry concepts—profile catalogs and resource registries—alongside esoteric fields like `dependsOn`, `alwaysOn`, and logical ID mappings.
2. **Violation of Core Design Principles**: Pi itself has no extension dependency graph or always-on concept; it simply loads configured extensions. Attempting to manage extension dependencies within `pi-profile` turns a lightweight profile switcher into an ad-hoc package manager, violating the first-principles directive: *Pi compatibility first, minimal like Pi, and act purely as a resource filter*.
3. **Bloated Command and UI Footprint**: The `/profile resource [list|create|edit|delete]` command family and interactive wizards add substantial complexity to the extension without providing value for standard extension usage.
4. **Maintenance and Migration Burden**: Users should simply install extensions through Pi (via `pi install` or placing scripts into standard extension directories) and select which ones to activate in their profile (`"extensions": ["pi-mcp-adapter", "my-local-tool"]`).

## Solution

Completely eliminate the Resource Registry (`resources.json`, `resources.schema.json`, `ResourceRegistry`, and `/profile resource *` commands).

Adopt a pure **"Discover & Filter"** architecture for extensions, mirroring how skills are handled:
1. **Native Extension Discovery**:
   - `pi-profile` automatically discovers available extensions by inspecting user-configured packages (`package.json#pi.extensions`), global loose files (`<agentDir>/extensions/*.{ts,js}`), and trusted project loose files (`<projectDir>/.pi/extensions/*.{ts,js}`).
   - Extension discovery is strictly read-only and never executes extension code.
2. **Pure Profile Filtering**:
   - Profiles reference extensions directly by package name (e.g. `pi-mcp-adapter`), package source alias (e.g. `npm:pi-mcp-adapter`), multi-entry specifier (e.g. `pkg:sub-ext.ts`), loose file stem (e.g. `conventions`), glob pattern (e.g. `pi-*`), or direct file path.
   - The profile resolver matches requested extension references directly against discovered extensions.
   - All `dependsOn` closure resolution, cycle detection, and `alwaysOn` restrictions are removed.
3. **Direct Runtime Overlays**:
   - Temporary runtime adjustments (`/profile customize -e <ext>`) directly filter active extensions without `alwaysOn` immutability gates.
4. **Streamlined Command Surface**:
   - The `/profile resource` command family and its interactive wizards are removed. The `/profile` command focuses purely on profile lifecycle (`use`, `list`, `status`, `customize`, `reset`, `create`, `edit`, `delete`, `duplicate`, `reload`).
5. **Clean Configuration**:
   - `profiles.json` becomes the sole configuration file in `pi-profile`. If a legacy `resources.json` exists, it is ignored (or ignored with a quiet deprecation warning).

## User Stories

1. As a Pi user, I want to reference an installed extension package by its package name in my profile's `extensions` array, so that I don't have to register it in any secondary file.
2. As a Pi user, I want to reference loose extensions in `~/.pi/agent/extensions/` by their file stem, so that I can toggle my custom extensions without manual configuration.
3. As a Pi user, I want to reference loose extensions in `.pi/extensions/` of a trusted project, so that project-specific extensions are discovered and filtered naturally.
4. As a Pi user, I want to use glob patterns in my profile's `extensions` array (e.g. `"pi-*"`, `"*guard*"`), so that matching extensions are dynamically included as they are added or installed.
5. As a Pi user, I want zero-match extension glob patterns to be recorded as warnings in `/profile status` and launch logs, so that typos in globs are easily diagnosed without blocking activation.
6. As a Pi user, I want unknown literal extension references to fail activation loudly with actionable error messages (including candidate lists and did-you-mean suggestions), so that mistakes are immediately caught.
7. As a Pi user, I want to reference an extension by an absolute or home-relative file path directly, so that one-off or externally located extension files work without registration ceremony.
8. As a Pi user, I want `pi-profile` to never perform dependency resolution (`dependsOn`) or cycle checks on extensions, so that extension loading semantics remain completely native to Pi.
9. As a Pi user, I want to be able to disable any extension via `/profile customize`, so that I have full runtime control without artificial `alwaysOn` restrictions.
10. As a Pi user, I want `/profile resource` commands and wizards to be removed, so that the command surface of `/profile` remains minimal and focused only on profiles.
11. As a Pi user, I want the extension help text and usage messages to reflect only profile-related commands, so that I am not presented with obsolete options.
12. As a Pi user, I want `profiles.json` to be the only configuration file required for `pi-profile`, so that maintaining my configuration is straightforward.
13. As a Pi user, I want any existing legacy `resources.json` file in my agent directory or project directory to be safely ignored, so that my existing setup does not break with unexpected parse errors.
14. As a Pi user, I want untrusted project `.pi/extensions/` to never be discovered or loaded, preserving the security trust model.
15. As a Pi user, I want `/profile status` to display the active profile's resolved extensions clearly without displaying obsolete registry origins or dependency trees.
16. As a Pi user, I want switching profiles (`/profile use <name>`) to swap active extensions via Pi's native reload without needing to restart the session.
17. As a Pi user, I want multi-entry extension packages to be selectable as a whole by package name or individually via `<package>:<entry>`, giving me flexible granularity.
18. As a Pi user, I want `pi-profile` to generate clean `settings.json` files that only contain the allowed extension paths and package configurations, keeping the runtime environment pristine.
19. As a Pi user, I want the default profile to continue exposing all discovered extensions without filtering, maintaining native Pi behavior.
20. As a developer integrating with RPC mode, I want structured status events to emit the resolved extension list cleanly without obsolete registry metadata.

## Implementation Decisions

1. **Retire Resource Registry & Store**:
   - Delete the explicit resource registry module, the on-disk resource registry store, and the resource registry CRUD orchestration and wizard modules.
   - Delete `resources.schema.json` and remove all resource registry schema validation tests and references.
   - Remove `resources.json` from the project trust evaluation list in `project-trust.ts`.

2. **Refactor Extension Discovery to Direct Model**:
   - The extension discovery module (`extension-discovery.ts`) becomes the sole authority on available extensions.
   - It outputs discovered extension items representing:
     - Configured user packages declaring `pi.extensions` in `package.json`.
     - Loose files in the global extensions directory (`<agentDir>/extensions/*.{ts,js}`).
     - Loose files in trusted project directories (`<projectDir>/.pi/extensions/*.{ts,js}`).
   - It provides lookup mechanisms to match references by:
     - Package name (e.g. `pi-mcp-adapter`)
     - Package source alias (e.g. `npm:pi-mcp-adapter`)
     - Multi-entry specifier (e.g. `pkg:path.ts`)
     - Loose file stem (e.g. `conventions`)
     - Absolute or home-relative file path (ad-hoc)

3. **Simplify Profile Resolver**:
   - `resolveProfile` accepts discovered extensions directly (similar to how it accepts `skills: SkillEntry[]`).
   - Extension reference resolution uses glob and literal matching against discovered extensions.
   - Completely remove:
     - `dependsOn` closure calculation and dependency sorting.
     - Cycle detection logic.
     - `alwaysOn` injection and enforcement.
     - `protectedIds` validation in runtime overlays (`disabledExtensions`).
   - When an extension glob matches nothing, it is reported in `ActivationPlan.unmatched` (matching skill glob behavior).
   - When an extension literal cannot be resolved, activation fails with an actionable error containing candidate names and spelling suggestions.

4. **Settings Generation Alignment**:
   - `SettingsGenerator` continues to receive `plan.extensions: Array<{ id: string; entry: string }>`.
   - It translates selected extension entries into:
     - Package allowlists in `settings.packages` (for package-owned extensions).
     - Absolute file paths in `settings.extensions` (for loose or path-based extensions).
   - No changes to the settings generation format are required, ensuring zero drift in Pi subprocess compatibility.

5. **Prune Extension Commands and UI**:
   - In `extensions/pi-profile/index.ts`, remove the `resource` subcommand from command parsing, autocomplete suggestions, and handler routing.
   - Update `/profile` usage and help messages to list only profile commands: `[use <name> | reload | customize ... | reset | list | status | create | edit <name> | delete <name> | duplicate]`.
   - Update `/profile create` and `/profile edit` wizard prompts to ask for extension names/globs directly instead of "resource ids".

6. **Status and Observability Simplification**:
   - In `src/status.ts`, format extension listings with their resolved entry paths and origins (package or local file), dropping all dependency or `alwaysOn` indicators.

## Testing Decisions

1. **Testing Philosophy**:
   - Test external behavior from the user's perspective, avoiding assertions on internal intermediate representations.
   - Use the highest viable seam across the system: the **Subprocess Launch & Switch Integration Seam**.
   - Ensure tests verify that Pi actually runs with the expected extensions loaded and unselected extensions excluded.

2. **Primary Seam: Subprocess Launch & Switch Integration Seam**:
   - Existing integration suites (`test/named-profile.integration.test.ts`, `test/switch.integration.test.ts`, `test/launcher.integration.test.ts`) spawn real `pi` subprocesses in isolated fixture environments.
   - Verify that:
     - Starting `pi-profile <name>` with `"extensions": ["ext-a"]` causes Pi to load only `ext-a` and filter out `ext-b`.
     - Switching profiles with `/profile use <target>` reloads settings and correctly activates `target`'s extensions without restarting the process.
     - Profiles with extension glob patterns expand correctly against installed packages and loose extension files.
     - Overlays (`/profile customize -e <ext>`) disable the targeted extension without rejection.
     - No `resources.json` file is required in any test fixture.

3. **Secondary Seam: Profile Resolver Seam**:
   - Fast component tests in `test/profile-resolver.test.ts` to test edge cases:
     - Exact literal matches (package name, alias, filename stem, file path).
     - Glob expansion and zero-match reporting in `unmatched`.
     - Actionable error messages when referencing non-existent extensions.
     - Overlay disables working uniformly across all extensions.

4. **Retirement of Obsolete Tests**:
   - Remove `test/resource-registry.test.ts`, `test/resource-registry-store.test.ts`, `test/resource-crud.test.ts`, and `test/resource-crud.integration.test.ts`.
   - Remove `resources.schema.json` validation tests from `test/schemas.test.ts`.
   - Update fixture helpers across test files to eliminate `writeResources` calls.

## Out of Scope

- Changing how Pi internally discovers or loads extensions in its core runtime.
- Managing prompt templates, themes, or context files (which remain unmanaged pass-throughs).
- Adding extension package installation or uninstallation commands to `pi-profile`.

## Further Notes

- This change aligns extension handling with skill handling, making the codebase significantly smaller, cleaner, and strictly faithful to the Pi-native compatibility principle.

## Comments

- 2026-09-17: All four implementation tickets completed and verified.
  - Ticket 01: Implemented `DiscoveredExtensions` and direct selection without `dependsOn`/`alwaysOn`.
  - Ticket 02: Removed `/profile resource` commands and wizards, updated usage and prompts.
  - Ticket 03: Deleted `resource-registry.ts`, `resource-registry-store.ts`, `resource-crud.ts`, `resource-wizard.ts`, `resources.schema.json`, `examples/resources.json`, and obsolete test files.
  - Ticket 04: Added `"extensions"` to `MANAGED_INSTANCE_FILES` in `settings-generator.ts`, cleaned up all fixture helpers, updated `docs/architecture/overview.md`, `CONTEXT.md`, and added `docs/adr/0007-discovery-only-extension-filtering.md`.
  - Full test suite: 39 test files, 300 tests passing. `tsc --noEmit` passes cleanly.
