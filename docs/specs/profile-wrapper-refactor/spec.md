# Specification: Thin Wrapper Architecture & Profile Instance Isolation Refactor

Status: done

Implementation notes (later commits): `PI_CODING_AGENT_SESSION_DIR` was removed — session continuity is achieved purely via the `sessions` symlink (f3ddb20). The workspace catalog/state gained legacy fallbacks under `~/.pi/agent` (see `src/workspace.ts`).

## Problem Statement

Users of `pi` require different working environments for distinct tasks (e.g., coding, reviewing, researching, minimal/offline work). Each task demands a tailored set of extensions, skills, tools, MCP servers, system instructions, and default models.

The current implementation of `pi-profile-switch` suffers from critical architectural limitations:
1. **Incomplete environment linking**: Profile instances only link a hardcoded whitelist of files from `~/.pi/agent`, breaking third-party Pi extensions (such as `pi-subagents`, `pi-web-access`, custom agents, and workflows) that expect other directories, agent memory, or extension-specific files to exist in `getAgentDir()`.
2. **Disconnected session management**: Sessions are currently isolated from native Pi sessions, preventing users from seamlessly continuing conversations between native `pi` and `pi-profile` or across profile switches.
3. **Directory pollution**: Profile instance runtime directories are stored inside `~/.pi` (e.g. `~/.pi/agent/pi-profile/runtime`), cluttering the native Pi configuration tree instead of keeping wrapper-managed state in its own dedicated workspace.
4. **Extension execution immutability in-process**: An in-process Pi extension cannot prevent other installed Pi extensions from executing at boot time or registering tools/hooks, making a subprocess launcher shell the only viable way to strictly enforce per-profile extension isolation.

## Solution

Rebuild `pi-profile-switch` as a clean, transparent **thin wrapper shell** around native `pi`.

The wrapper operates on the following principles:
1. **Dedicated Workspace (`~/.pi-profile-switch`)**: All profile definitions, catalogs, and instance runtime directories live under `~/.pi-profile-switch/`. The native `~/.pi` configuration directory is never polluted with temporary or runtime directories.
2. **Full-Fidelity Symlink Mirroring**: For each profile instance, the wrapper creates a runtime agent directory where every existing file and directory in `~/.pi/agent` (auth, models, trust, npm, git, bin, prompts, agents, workflows, extension state) is symlinked back to the real `~/.pi/agent`. Only files explicitly customized by the profile (`settings.json`, `mcp.json`, and `APPEND_SYSTEM.md`) are independently generated for that instance.
3. **Unified Native Session Continuity**: The instance `agent/sessions` directory is symlinked directly to `~/.pi/agent/sessions`, and `PI_CODING_AGENT_SESSION_DIR` is set to point to `~/.pi/agent/sessions`. All native session operations (`-c`, `-r`, `/resume`, `/new`, `/fork`, `/tree`) work natively, allowing unbroken continuity between native `pi` and any profile instance.
4. **Declarative Per-Profile Capability Configuration**: The wrapper customizes the instance's generated `settings.json`, `mcp.json`, and `APPEND_SYSTEM.md` according to the profile definition:
   - **Extensions**: Enabled/disabled via `settings.json` `packages` filters and `extensions` paths.
   - **Skills**: Filtered via `settings.json` `packages` filters, `skills` paths, and exclusion patterns.
   - **Tools**: Configured via `defaultTools` in `settings.json` and launcher `--tools` forwarding.
   - **MCP Servers**: Filtered in instance `<agentDir>/mcp.json` so `pi-mcp-adapter` connects only to profile-allowed servers.
   - **Instructions**: Written to `<agentDir>/APPEND_SYSTEM.md`, which Pi automatically appends to system prompt without needing monkey patches.
   - **Default Model**: Configured via `defaultProvider`, `defaultModel`, and `defaultThinkingLevel` in generated `settings.json`.

## User Stories

1. As a developer, I want to launch Pi with a named profile (e.g. `pi-profile review`), so that my session starts with only the extensions, skills, tools, and model suitable for code review.
2. As a developer, I want to launch `pi-profile` with the default profile when no profile name is provided, so that I get my full native Pi capabilities without manual configuration.
3. As a developer, I want all my credentials in `auth.json` and custom model endpoints in `models.json` to be available automatically in every profile, so that I don't have to log in or configure providers separately.
4. As a developer, I want third-party Pi extensions (like `pi-subagents` or `pi-web-access`) to work seamlessly inside any profile where they are enabled, so that custom agents, workflows, and extension storage function without errors.
5. As a developer, I want to continue my previous session using `pi-profile <name> -c`, so that I can resume work started either in native `pi` or in a different profile.
6. As a developer, I want to browse past sessions using `pi-profile <name> -r`, so that I can pick from all my project sessions regardless of which profile created them.
7. As a developer, I want new sessions created in `pi-profile` to be saved in `~/.pi/agent/sessions`, so that they appear in native `pi` session history when I use `pi` directly.
8. As a developer, I want `pi-profile-switch` to keep its instances and catalogs in `~/.pi-profile-switch/`, so that my `~/.pi/` directory remains clean and reserved exclusively for native Pi files.
9. As a developer, I want to customize which extensions are loaded in each profile, so that heavyweight or specialized extensions do not consume memory or interfere with prompts in profiles that don't need them.
10. As a developer, I want to customize which skills are available in each profile, so that the agent's context window is not cluttered with irrelevant skill descriptions.
11. As a developer, I want to configure `defaultTools` (such as `read`, `grep`, `find`, `ls`) for a read-only profile, so that the agent cannot execute write or bash commands.
12. As a developer, I want to restrict MCP servers per profile, so that only relevant external tools (e.g., database or Jira) are connected during sensitive or specialized sessions.
13. As a developer, I want to define custom system prompt instructions per profile, so that the agent adopts specific roles, tone, and operational guidelines automatically.
14. As a developer, I want to configure default model and reasoning levels per profile, so that coding tasks use high-reasoning models while quick review tasks use lightweight models.
15. As a developer, I want to pass arbitrary Pi CLI flags (e.g. `--mode rpc`, `-p "prompt"`, `--no-session`) through `pi-profile`, so that the wrapper supports all native Pi operational modes.
16. As a developer, I want profile switching inside a running session via `/profile use <name>`, so that I can transition to another profile's capabilities without losing conversation context.
17. As a developer, I want to see the active profile in the status command and footer badge, so that I am always aware of the active profile constraints and loaded resources.
18. As a developer, I want project-specific profiles defined in `.pi/profiles.json`, so that team-shared profile definitions can be committed to repository version control.
19. As a developer, I want project profiles to respect Pi's project trust boundary, so that untrusted repositories cannot execute unauthorized extensions or modify configuration.
20. As a developer, I want instant startup when launching an already-materialized profile instance whose definition hasn't changed, so that `pi-profile` adds negligible startup overhead.

## Implementation Decisions

### 1. Workspace Layout (`~/.pi-profile-switch`)
- Dedicated root: `~/.pi-profile-switch`.
- Global catalog: `~/.pi-profile-switch/profiles.json` (fallback check to `~/.pi/agent/profiles.json` for migration).
- Instances directory: `~/.pi-profile-switch/instances/<profile-name>/agent`.
- Zero files written into `~/.pi` by the wrapper.

### 2. Full Symlink Mirroring Strategy
- When materializing an instance at `~/.pi-profile-switch/instances/<profile-name>/agent`:
  - Inspect `~/.pi/agent` using directory scanning.
  - For every entry in `~/.pi/agent` except `settings.json`, `mcp.json`, and `APPEND_SYSTEM.md`:
    - Create a symbolic link in the instance agent directory pointing to the canonical path in `~/.pi/agent`.
    - Handles files (`auth.json`, `models.json`, `models-store.json`, `trust.json`, `subagents.json`, `pi-plan-build.json`, etc.) and directories (`npm`, `git`, `bin`, `prompts`, `skills`, `agents`, `workflows`, `agent-memory`, etc.).
  - `sessions` is explicitly symlinked to `~/.pi/agent/sessions`.
  - Re-syncing check on each launch ensures newly added files or directories in `~/.pi/agent` are mirrored.

### 3. Generated Profile Files
- `settings.json`:
  - Deep-merged from user's base `~/.pi/agent/settings.json`.
  - Injects `defaultProvider`, `defaultModel`, `defaultThinkingLevel` if specified.
  - Injects `defaultTools` if specified.
  - Injects package and extension filter rules (disabling excluded extensions via package object syntax `{ source: "...", extensions: [] }`).
  - Injects skill inclusion/exclusion rules.
- `mcp.json`:
  - If the profile declares an `mcps` array, read `~/.pi/agent/mcp.json` and output an instance `mcp.json` keeping only the matching server configurations.
  - If the profile does not restrict MCP servers, symlink directly to `~/.pi/agent/mcp.json`.
- `APPEND_SYSTEM.md`:
  - If the profile specifies `instructions`, write the instruction string to `APPEND_SYSTEM.md` in the instance agent directory. Pi's native resource loader automatically appends this file to the system prompt.
  - If no instructions are specified, ensure no stale `APPEND_SYSTEM.md` remains in the instance directory.

### 4. Process Spawning and Environment
- Wrapper binary `pi-profile` spawns `pi` subprocess using `child_process.spawn`.
- Environment variables passed to child:
  - `PI_CODING_AGENT_DIR`: Set to `~/.pi-profile-switch/instances/<profile-name>/agent`.
  - `PI_CODING_AGENT_SESSION_DIR`: Set to `path.join(homedir(), ".pi", "agent", "sessions")`.
  - Inherit all other process environment variables.
- Standard I/O is set to `inherit` so interactive TUI, raw terminal inputs, OSC sequences, and RPC modes function natively.
- Signal handlers for `SIGINT` and `SIGTERM` propagate directly to the spawned child process.

### 5. In-Session Switching
- The extension component inside the running Pi instance handles `/profile use <name>`.
- To switch:
  - Verify target profile exists.
  - Update instance `settings.json`, `mcp.json`, and `APPEND_SYSTEM.md` to reflect the target profile.
  - Invoke `ctx.reload()`. Pi re-reads settings from `PI_CODING_AGENT_DIR`, unloads and reloads extensions, and keeps the active session intact.

## Testing Decisions

### Good Test Criteria
- Tests must verify observable behavior (directory structure, symlink targets, generated JSON structure, CLI argument pass-through, exit codes) rather than private implementation details.
- Integration tests should execute against temporary test fixture directories (`HOME=/tmp/test-fixture`) without modifying the developer's real `~/.pi` or `~/.pi-profile-switch`.

### Modules Tested
1. **Catalog Store**: Reading, validating, and writing global and project catalogs; schema compliance; migration fallbacks.
2. **Instance Materializer**:
   - Creating full symlink mirrors for all files and directories in a mocked `~/.pi/agent`.
   - Ensuring `settings.json`, `mcp.json`, and `APPEND_SYSTEM.md` reflect the profile's specification.
   - Verifying `sessions` links to `~/.pi/agent/sessions`.
   - Verifying no files are created outside `~/.pi-profile-switch`.
3. **Settings Generator**: Correct composition of package filtering, tool restrictions, and model defaults.
4. **Launcher CLI**: Argument parsing, command forwarding (`-c`, `-r`, `--mode`), environment variable configuration, and error exit codes.

### Prior Art
- Unit and integration tests in `test/` using Vitest.
- Fixture-based isolation patterns from Pi's own test harness.

## Out of Scope
- Profile inheritance or prototype chaining (profiles remain flat, self-contained definitions).
- Automatic remote synchronization of profiles across machines.
- Managing user authentication credentials or API keys (delegated entirely to native Pi).

## Further Notes
- This architecture cleanly resolves the fundamental tension between Pi extension lifecycle (which boots before extensions can modify other extensions) and profile customization: by acting as a thin shell around Pi, it configures Pi's native bootloader inputs without hacking internal runtime structures.
