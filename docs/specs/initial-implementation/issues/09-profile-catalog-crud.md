# 09: Profile catalog CRUD

**What to build:** TUI CRUD for profile catalogs: `/profile create` asks explicitly whether to write the global or project catalog; editors produce self-contained profile definitions (no inheritance, glob references allowed); editing the active profile reactivates it immediately after save (rewrite settings + reload); deleting the active profile requires choosing a replacement first; variants are made by copying a complete definition under a new name.

**Blocked by:** 03 (Project trust mirroring, project catalogs, and scope-aware state), 05 (In-session switching, reload, and rollback), 08 (Resource-registry CRUD)

**Status:** done

- [x] `/profile create` prompts for global vs project scope before writing; the created profile is immediately usable and appears in `/profile list` with the correct source.
- [x] Saved definitions are complete and self-contained; the editor has no inheritance concept (no `extends`, no merge, no array append).
- [x] Saving an edit to the active profile rewrites settings and reloads immediately; edits to inactive profiles do not touch the runtime.
- [x] `/profile delete` on the active profile requires selecting a replacement first; deleting a project override reveals the global profile of the same name.
- [x] The wizard can duplicate an existing profile's full definition under a new name — the only variant mechanism.
- [x] CRUD is available only in TUI mode.

## Comments

**2026-09-12 — completed**

**Addendum (ticket 11)**: the CRUD availability gate moved from `hasUI` to `ctx.mode === "tui"` (RPC has dialog-capable UI, so hasUI was the wrong predicate for TUI-only CRUD). The RPC-driven wizard integration tests became mode-refusal assertions; wizard flows remain unit-tested with a TUI-mode fake context. (review fixes: trust-gated catalog reads via exported `readCatalogScope`/`catalogStore`, symmetric override-reveal both directions, wizard docblock, duplicate non-interactive gate test)

Write side `src/profile-catalog-store.ts` mirrors the resource store (whole-file overwrite, schema envelope, definitions re-parsed through the catalog's own `parseProfileDefinition` — now exported — so only declared fields survive a save; inheritance keys like `extends` can't persist by construction). Orchestration `src/switching/profile-crud.ts`: scope trust gate, duplicate/unknown-name refusals, active-delete requires a replacement, `default` untouchable. Wizard `src/switching/profile-wizard.ts`: create asks scope first (no dialog when untrusted — global only), captures label/description/skills/extensions/mcp/tools/instructions/model (`provider/id[/thinking]`); edit prefills and empty answers keep current values (no field-clearing gesture — delete + create instead); duplicate copies the complete definition under a new name.

Delete semantics: when both scopes hold the name the user picks which record to delete; deleting a project override of the ACTIVE profile reveals the global same-name definition and reloads in place (the session stays on the revealed definition); deleting a solely-owned active profile requires selecting a replacement from the survivors, then switches to it (overlay cleared). Edit/delete target the winning definition's source scope. CRUD is gated on `ctx.hasUI` (list stays readable everywhere via ticket 07's `/profile list`).

Verification: `tsc --noEmit` clean; `vitest run` 277/277 across 35 files. Integration (real pi, RPC dialogs): create → visible in `/profile list` → activatable; edit-active swaps resolved skill commands in place; delete-active prompts replacement and the session lands on it.
