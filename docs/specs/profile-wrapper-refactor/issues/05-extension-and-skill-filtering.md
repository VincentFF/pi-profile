# 05: Per-profile extension and skill filtering in generated settings

**What to build:**
Resource filtering in the generated `settings.json` so that each profile loads only its designated extensions and skills:
- **Extensions**: For all installed packages (npm/git/local), rewrite entries into Pi's object syntax (`{ source: "...", extensions: [...] }`) to disable unselected extensions. Filter the `extensions` array for local extension paths.
- **Skills**: Filter package skills via package filtering syntax. Filter auto-discovered skills (`~/.agents/skills` and `<agentDir>/skills`) using Pi's exclusion patterns (`!*`, `-path`) and additive paths (`+path`).
- Unmanaged resource kinds (themes, prompt templates) pass through untouched from the user's base settings.

**Blocked by:** 04: Per-profile generation of model, tools, MCP servers, and instructions

**Status:** resolved

- [ ] Generates `packages` settings that filter or disable extensions not in the profile's allowed extension list.
- [ ] Filters local `extensions` paths in `settings.json`.
- [ ] Generates `packages` settings that filter or disable skills not in the profile's allowed skill list.
- [ ] Applies skill exclusion patterns to suppress unwanted auto-discovered skills from `~/.agents/skills`.
- [ ] Merges untouched settings (themes, prompts, compaction, retry) cleanly from the base `~/.pi/agent/settings.json`.
- [ ] Integration test verifies that launching with an extension-filtered profile loads only the specified extension.
