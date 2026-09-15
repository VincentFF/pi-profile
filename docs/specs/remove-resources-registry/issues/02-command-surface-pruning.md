# 02: Command surface pruning (/profile resource removal and wizard updates)

**What to build:** Prune the `/profile resource` command family and its interactive wizards from the extension runtime. Update `/profile` usage and help text, autocompletion suggestions, and update the `/profile create` and `/profile edit` wizard prompts to ask for extension names/globs instead of "resource IDs".

**Blocked by:** 01 (Direct extension discovery and profile resolver simplification)

**Status:** resolved

- [x] Remove `resource` subcommand from `/profile` command handler in `extensions/pi-profile/index.ts`.
- [x] Update `/profile` usage and help messages to exclude `resource`.
- [x] Remove `resource` from autocompletion suggestions.
- [x] Update `/profile create` and `/profile edit` wizards to prompt for extension names or globs instead of "resource ids".
- [x] Update `/profile status` to display resolved extension entries cleanly without registry origin or dependency indicators.
- [x] Remove obsolete resource CRUD tests and ensure profile CRUD tests pass.

## Answer

Pruned the `/profile resource` command family and wizard handlers from `extensions/pi-profile/index.ts`. Updated `/profile` description, usage messages, and subcommand validation. Updated `/profile create` and `/profile edit` wizard prompts in `src/switching/profile-wizard.ts` to request extension names or globs instead of resource IDs. Updated `test/extension.test.ts` to assert that `/profile resource` is rejected as an unknown subcommand. All profile CRUD tests pass cleanly.
