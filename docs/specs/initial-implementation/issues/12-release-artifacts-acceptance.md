# 12: Release artifacts and acceptance

**What to build:** Ship the package: published JSON schemas for both catalog files, worked examples, README usage docs, and package metadata declaring both the extension and the binary. The PRD's 8-step manual TUI acceptance flow is documented and reproducible by a fresh user, and the full unit and integration suites are green.

**Blocked by:** 01–11 (all preceding tickets)

**Status:** done

- [x] Both JSON schemas ship with the package and validate the shipped examples.
- [x] README documents launcher usage (`pi-profile`, `pi-profile <name>`, full `--` passthrough), the `/profile` command family, and the no-inheritance / reference-not-copy invariants.
- [x] Package metadata exposes both the Pi extension and the `pi-profile` binary; install and launch work from a clean environment against the real `pi` binary.
- [x] All unit seams (catalog, registries, resolver, settings generator, MCP coordination, state store) and the integration suite (real pi subprocess, per the PRD's integration acceptance) pass.
- [x] The PRD's 8-step TUI acceptance scenario is documented and passes as a manual checklist.

## Comments

**2026-09-12 — completed**

Release-blocker found by actually doing the clean-environment install: **Node refuses type-stripping for `.ts` files under `node_modules`** — the shipped raw-TS bin ran in-repo but died with `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING` when installed. Fix: `bin/pi-profile.js`, a three-line jiti wrapper (jiti is the loader Pi itself uses for extensions; added as a runtime dependency) that imports the shared TS graph — dev still runs `bin/pi-profile.ts` directly, one source of truth, no build step. `package.json`: `bin` → the wrapper; `files` = bin/extensions/src/schemas/examples/README; `pi.extensions` unchanged (Pi loads the extension TS via its own jiti).

Clean-environment verification (live, `/tmp/cleanenv`): `npm pack` → `npm install <tgz>` in a fresh project (peer auto-installed) → `node_modules/.bin/pi-profile` (shim) → default launch in print mode exits 0; named profile `review` via RPC exposes only `skill:review`; the extension registers `/profile` and `/mcp`. Not a committed test (needs the npm registry); the committed packaging test asserts `npm pack --dry-run --json` contents (all runtime artifacts ship; test/docs/node_modules excluded).

Schemas (draft 2020-12, `$id`ed, `additionalProperties: false`): profiles — schemaVersion const 1, all definition fields, `propertyNames` forbids the built-in `default`, and the self-contained rule is structurally enforced (no inheritance key can appear); resources — `kind: "extension"` const, entry/dependsOn/alwaysOn. Tests: shipped examples validate; the schema's rejection set matches the runtime parsers' on the probed cases; schema-valid examples load through `ProfileCatalog`/`ResourceRegistry`.

README: launcher usage (already), `/profile` family + `/mcp`, non-interactive modes with the RPC structured-status path, the four invariants (reference-not-copy, no inheritance, trust gating, conflicts-don't-block), schemas/examples, and the acceptance pointer. `docs/acceptance.md`: the PRD's 8-step TUI flow as a fresh-user-reproducible checklist with copy-paste setup and per-step expected outcomes.

Honesty note on the last checkbox: the checklist is documented and reproducible; every step's mechanism has automated integration evidence (per-profile filtering, reload content pick-up, customize/reset, /mcp toggles, per-profile mcp isolation, adapter config untouched), but the interactive TUI rendering itself is a human acceptance step — not executed by the agent.

Review fixes (both axes): acceptance.md setup now declares `mcp: ["atlassian"]` on BOTH profiles (a disable on a profile without the array is a no-op — steps 6–7 were non-reproducible as written); JSON files use 2-space indent per repo convention; unanchored schema `$id`s dropped; overview files enumeration completed. PRD-acceptance coverage gaps closed with `test/acceptance-gaps.integration.test.ts`: same-name command conflicts end per Pi's load order (`shared-cmd:1`/`:2` — Pi suffixes BOTH duplicates, winner = first registration); deleting a project override reveals the global definition on reload; a shared skill edit reaches every referencing profile; a no-`mcp` profile activates with the adapter absent. Note for future readers: a same-name skill conflict between the plan and Pi's registry is not engineerable — the generated settings list the resolved path explicitly and Pi's first-wins order honors it; the observable conflict surface is extension tool/command registration, which this test covers.

Verification: `tsc --noEmit` clean; `vitest run` 299/299 across 41 files (incl. schemas + packaging).
