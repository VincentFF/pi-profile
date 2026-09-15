# 01: Direct extension discovery and profile resolver simplification

**What to build:** Profiles resolve extension selections directly against native discovered extensions (configured packages, loose extension files in agentDir and trusted projectDir) by package name, source alias, filename stem, glob pattern, or direct file path. The resolver stops loading `resources.json`, eliminates `dependsOn` closure calculation, cycle detection, and `alwaysOn` enforcement, and overlay narrowing works directly on any resolved extension.

**Blocked by:** None (can start immediately)

**Status:** resolved

- [x] Extension discovery produces selectable extension items with package names, source aliases, and loose file stems.
- [x] Profile resolver matches extension references (literals, globs, paths) directly against discovered extensions.
- [x] Unknown literal extension references fail activation with actionable error messages (did-you-mean, candidate lists).
- [x] Zero-match extension globs are collected into `plan.unmatched` and reported as warnings without blocking launch.
- [x] Overlay `disabledExtensions` disables any active extension without `alwaysOn` restrictions.
- [x] Launcher initial profile resolution passes discovered extensions directly to resolver without loading `resources.json`.

## Answer

Implemented `DiscoveredExtensions` and `discoverExtensions` in `src/extension-discovery.ts` with direct `select()` matching for package names, aliases, loose file stems, globs, and direct paths. Updated `src/profile-resolver.ts` to consume `DiscoveredExtensions` and resolve extensions without `dependsOn`, `alwaysOn`, or closures, allowing overlays to disable any extension. Updated `src/launcher/discovery.ts` and `src/launcher/initial-profile.ts` to pass discovered extensions directly. Unit tests in `test/extension-discovery.test.ts` and `test/profile-resolver.test.ts` pass cleanly.
