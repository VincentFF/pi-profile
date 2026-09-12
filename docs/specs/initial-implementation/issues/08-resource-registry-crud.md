# 08: Resource-registry CRUD

**What to build:** TUI CRUD for the extension resource registry: list, create, edit, and delete entries in the global or project registry through the `/profile resource` command family. Deletion is refused while any profile or resource `dependsOn` references the entry. Project IDs continue to override global ones, and registry errors (cycles, missing entries) surface loudly at activation time. Changes take effect through the standard rewrite-settings-and-reload path.

**Blocked by:** 03 (Project trust mirroring, project catalogs, and scope-aware state), 05 (In-session switching, reload, and rollback)

**Status:** ready-for-agent

- [ ] `/profile resource list|create|edit|delete` work in TUI mode for both global and project registries; the create/edit wizard captures logical ID, entry path, `dependsOn`, and `alwaysOn`.
- [ ] Entries are `extension` kind only; MCP capabilities cannot be declared through the resource registry.
- [ ] Deleting an entry referenced by any profile or by another resource's `dependsOn` is rejected with a clear message.
- [ ] Project-registry changes (new IDs, same-ID overrides) take effect on the next activation or reload.
- [ ] Wizard saves overwrite external concurrent catalog edits instead of blocking on them.
