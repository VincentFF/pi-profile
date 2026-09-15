# 03: Retire Resource Registry, schemas, and storage code

**What to build:** Delete all obsolete ResourceRegistry code, schemas, and storage files. Remove `resources.json` from project trust evaluation in `src/project-trust.ts`. Update packaging and schema tests to ensure the distribution is clean.

**Blocked by:** 01 (Direct extension discovery and profile resolver simplification), 02 (Command surface pruning)

**Status:** resolved

- [x] Delete `src/resource-registry.ts` and `src/resource-registry-store.ts`.
- [x] Delete `src/switching/resource-crud.ts` and `src/switching/resource-wizard.ts`.
- [x] Delete `schemas/resources.schema.json` and `examples/resources.json`.
- [x] Remove `resources.json` from trust-requiring project files in `src/project-trust.ts`.
- [x] Update `test/packaging.test.ts` and `test/schemas.test.ts` to remove expectations for `resources.schema.json` and `examples/resources.json`.
- [x] Delete obsolete test files: `test/resource-registry.test.ts`, `test/resource-registry-store.test.ts`, `test/resource-crud.test.ts`, `test/resource-crud.integration.test.ts`.

## Answer

Deleted `src/resource-registry.ts`, `src/resource-registry-store.ts`, `src/switching/resource-crud.ts`, `src/switching/resource-wizard.ts`, `schemas/resources.schema.json`, and `examples/resources.json`. Removed `resources.json` from `src/project-trust.ts` and `RegistryError` from `bin/pi-profile.ts`. Removed obsolete tests `test/resource-registry.test.ts`, `test/resource-registry-store.test.ts`, `test/resource-crud.test.ts`, and `test/resource-crud.integration.test.ts`. Updated `test/packaging.test.ts` and `test/schemas.test.ts`. Typecheck `tsc --noEmit` is completely clean.
