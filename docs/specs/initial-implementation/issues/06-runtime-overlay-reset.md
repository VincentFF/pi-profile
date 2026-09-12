# 06: Runtime overlay customization and reset

**What to build:** The runtime overlay as the temporary-adjustment mechanism: `/profile customize` adjusts the active profile's skills, extensions, MCP servers, and tools for the current runtime only — written to runtime state, never to any catalog — and applied through the same rewrite-settings-and-reload path as a switch. Overlays cannot disable `alwaysOn` resources or their direct dependents, so safety gates survive experimentation. `/profile reset` discards the overlay and reactivates the profile exactly as declared.

**Blocked by:** 05 (In-session switching, reload, and rollback)

**Status:** done

- [x] `/profile customize` changes take effect after reload, persist only in runtime state (never in catalog files), and do not outlive the runtime unless reapplied.
- [x] Disabling an `alwaysOn` resource, or a resource in its dependency chain, via overlay is rejected at resolution time.
- [x] One runtime holds exactly one active profile and at most one overlay; multi-profile stacking does not exist.
- [x] `/profile reset` deletes the overlay and reactivates the profile definition exactly as declared (rewrite settings + reload).
- [x] Unit coverage at the resolver boundary: overlay application, `alwaysOn` protection, and reset semantics.

## Comments

**2026-09-12 — completed**

Overlay semantics: narrowing-only (`disabledSkills`/`disabledExtensions`/`disabledMcp` remove resolved resources; `tools` replaces the profile's tool references). Stored in the scope state file as the persistence/status surface — the launcher never reads it, so an overlay never outlives its runtime; the runtime effect flows through re-resolution with the overlay, sharing the switch path (snapshot → rewrite → reload → staleness-verified rollback). Overlay references must name resources the profile actually resolves (loud typos); `alwaysOn` extensions and their TRANSITIVE dependency chain are protected (spec story 21 said "direct dependencies" — the ticket's own "dependency chain" wording and the safety intent won; spec.md and overview.md updated to 传递闭包). Removal is post-closure: disabling a regular (non-alwaysOn) dependency of a selected extension is allowed, as experimentation requires.

Default-profile overlays materialize a synthetic `{skills: ["*"], extensions: ["*"]}` selection; MCP narrowing on default is rejected (the adapter's own /mcp commands own that surface natively). Ordering invariants: customize validates (re-resolve) before writing anything, switches, then persists the overlay — a failed switch leaves state consistent with the rolled-back runtime; reset switches without the overlay, then deletes it. `/profile reload` re-applies the stored overlay (a plain reload after customize must not diverge runtime from state); `/profile use` clears the stored overlay via the `clearOverlay` plan marker merged by the post-reload state write (which otherwise preserves the overlay across reloads).

Command grammar: `/profile customize disable|enable skill|extension|mcp <name>` and `/profile customize tools [ref...]` (empty clears the override); `/profile reset`. Known cosmetic residue: switching scopes leaves the old scope's overlay in its state file — inert (nothing reads it at launch) and visible via `/profile status` (ticket 07).

Verification: `tsc --noEmit` clean; `vitest run` 216/216 across 22 files. Integration (real pi): customize narrows the runtime with the catalog byte-untouched and the next launch clean; alwaysOn + chain rejection end-to-end; switch discards the overlay. Review fixes applied: reload re-applies stored overlays (state/runtime divergence hole), single customize usage string, record-based kind mapping, no non-null assertions, doc wording aligned.
