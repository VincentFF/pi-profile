# 08: Resource-registry CRUD

**What to build:** TUI CRUD for the extension resource registry: list, create, edit, and delete entries in the global or project registry through the `/profile resource` command family. Deletion is refused while any profile or resource `dependsOn` references the entry. Project IDs continue to override global ones, and registry errors (cycles, missing entries) surface loudly at activation time. Changes take effect through the standard rewrite-settings-and-reload path.

**Blocked by:** 03 (Project trust mirroring, project catalogs, and scope-aware state), 05 (In-session switching, reload, and rollback)

**Status:** done

- [x] `/profile resource list|create|edit|delete` work in TUI mode for both global and project registries; the create/edit wizard captures logical ID, entry path, `dependsOn`, and `alwaysOn`.
- [x] Entries are `extension` kind only; MCP capabilities cannot be declared through the resource registry.
- [x] Deleting an entry referenced by any profile or by another resource's `dependsOn` is rejected with a clear message.
- [x] Project-registry changes (new IDs, same-ID overrides) take effect on the next activation or reload.
- [x] Wizard saves overwrite external concurrent catalog edits instead of blocking on them.

## Comments

**2026-09-12 — completed**

**Addendum (ticket 11)**: the CRUD availability gate moved from `hasUI` to `ctx.mode === "tui"` (RPC has dialog-capable UI, so hasUI was the wrong predicate for TUI-only CRUD). The RPC-driven wizard integration tests became mode-refusal assertions; wizard flows remain unit-tested with a TUI-mode fake context. (review fixes: extension header docblock, wizard path hint, overview gloss, import merge)

Write side lives in `src/resource-registry-store.ts` (whole-file overwrite, schemaVersion envelope, entries re-parsed through the registry's own `parseResourceEntry` so anything written is loadable; missing file → empty skeleton; malformed file → RegistryError even on the write path). Orchestration in `src/switching/resource-crud.ts`: trust-gated merged listing (project shadows global), referrer scan across BOTH scopes (shadowed global profiles still activate elsewhere, so their references keep the entry alive) plus cross-scope `dependsOn`, delete refusal naming every referrer, project-scope mutations rejected when untrusted. Wizard in `src/switching/resource-wizard.ts` with an injected `{select, input, confirm}` UI; any cancelled step aborts without writing. Save semantics: re-read at write time — never blocks on concurrent edits (ticket requirement), unrelated external entries survive, same-entry conflicts resolve last-write-wins. All mutations apply through the standard `reloadCurrent` switch path.

Found while integrating: post-reload `ctx.ui.notify` throws on the stale command context (Pi invalidates it on reload), which surfaced as `extension_error` events and swallowed success messages. Fixed systematically — mutation success notifies fire BEFORE the reload; all notifies are now stale-tolerant (post-reload feedback is the new instance's session_start summary). Also confirmed semantics: the built-in default profile resolves zero pi-profile resources (ticket 02 purity), so `alwaysOn` loads in named profiles only — the integration test drives the create→reload→loaded flow on a named profile.

Verification: `tsc --noEmit` clean; `vitest run` 250/250 across 31 files. Integration (real pi, RPC dialogs scripted): wizard create captures id/entry/dependsOn/alwaysOn into the global registry and the auto-reload loads the alwaysOn entry (session_start marker); delete is refused while a profile references the entry (file untouched) and succeeds once unreferenced.
