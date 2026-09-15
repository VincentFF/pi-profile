# 04: End-to-end integration verification and architecture docs update

**What to build:** Verify the full test suite across launcher, in-session profile switches, and runtime overlays running completely without `resources.json`. Update architecture documentation (`docs/architecture/overview.md`), domain glossary (`CONTEXT.md`), and ADR records to reflect the pure discover-and-filter extension model.

**Blocked by:** 03 (Retire Resource Registry, schemas, and storage code)

**Status:** resolved

- [x] Clean up fixture helpers across integration tests (e.g. `writeResources`) and ensure fixtures do not write `resources.json`.
- [x] Verify that launcher integration tests pass with pure discovery and filtering.
- [x] Verify that in-session switch and reload integration tests pass without `resources.json`.
- [x] Verify that runtime overlay tests (`/profile customize -e <ext>`) succeed without `alwaysOn` restrictions.
- [x] Update `docs/architecture/overview.md` to remove ResourceRegistry and document direct ExtensionDiscovery.
- [x] Update `CONTEXT.md` to remove ResourceRegistry, `resources.json`, `alwaysOn`, and `dependsOn`.
- [x] Add ADR-0007 recording the retirement of the resource registry in favor of native discovery and pure filtering.
- [x] Full test suite passes and `tsc --noEmit` is clean.

## Answer

All test fixtures cleaned up; zero fixtures write `resources.json`. Added `"extensions"` to `MANAGED_INSTANCE_FILES` in `src/settings-generator.ts` so agentDir extensions are never auto-symlinked, ensuring pure allowlist filtering. Updated `docs/architecture/overview.md`, `CONTEXT.md`, and added `docs/adr/0007-discovery-only-extension-filtering.md`. Full test suite (39 test files, 300 tests) passes 100% cleanly and `tsc --noEmit` passes with 0 errors.
