# pi-profile-switch

[English](README.md) | [中文](README.zh-CN.md)

Named profiles for [Pi](https://github.com/badlogic/pi-mono). A profile selects what the model sees and which capabilities the session uses — skills, MCP servers, tools, a model preset, and extra instructions — switchable in the same Pi process.

Use a lean read-only profile for code review, a full-powered one for implementation, a minimal one for a quick question.

`pi-profile-switch` is a plain Pi package (ADR-0007). It installs like any other extension, leaves Pi's configuration directory untouched, and keeps sessions, packages, project trust, and every other installed extension native.

## Install

```bash
pi install npm:pi-profile-switch
```

Requires [Pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) (installed automatically as a peer dependency).

## Quick start

```bash
# Use the saved profile (or the built-in default)
pi

# Use a profile for this run only (not saved)
pi --profile review

# The explicit native baseline
pi --profile default
```

Define profiles in `~/.pi/agent/profiles.json` (global) or `<project>/.pi/profiles.json` (project, trusted projects only):

```json
{
  "schemaVersion": 2,
  "profiles": {
    "review": {
      "label": "Code review",
      "skills": ["code-review"],
      "mcp": ["github"],
      "tools": ["read", "grep", "find", "bash"],
      "instructions": "Review only; do not modify files."
    }
  }
}
```

Profiles **reference** resources by name — they never copy them. Full schema with more examples: [`examples/profiles.json`](examples/profiles.json).

Existing `schemaVersion: 1` catalogs keep working: the `extensions` field is reported once and ignored, because extensions now load natively in every profile.

## What a profile controls

| Field | Effect |
| --- | --- |
| `instructions` | Text appended to the system prompt every turn |
| `model` | Session-start model preset; an explicit `--model`/`--thinking` or a model recorded in the session wins |
| `skills` | What the model sees in the prompt's skills list. Every installed skill stays loaded and callable by the user through `/skill:name` |
| `mcp` | Runtime server allowlist published to `pi-mcp-adapter`; connection details stay in the adapter's own config |
| `tools` | Active tool set: declared names/globs become the active set; names that register later (MCP, extensions) are applied when they appear |

Anything a profile does not declare keeps Pi's native behavior, and `default` declares nothing.

## Commands

In the TUI, the `/profile` command family manages everything in-session:

| Command | What it does |
| --- | --- |
| `/profile` | Interactive profile picker |
| `/profile list` / `/profile status` | Show profiles / active profile details |
| `/profile use <name>` | Switch instantly — same session, no reload |
| `/profile create\|edit\|delete\|duplicate` | Guided profile CRUD (TUI only) |
| `/profile customize` / `/profile reset` | Narrow the active profile for this session only |
| `/mcp enable\|disable <server>` | Toggle MCP servers in the active profile |

All commands work in non-interactive modes (`--mode rpc|print|json`); CRUD wizards are TUI-only.

## Guarantees

- **Reference, never copy** — profiles point at resources you already own and maintain.
- **Pi-native** — the configuration directory is Pi's own, so sessions, extension config, packages, context files, and trust behave exactly as they do in plain Pi.
- **Fail safe** — untrusted project directories are never read; a failed activation applies nothing and reports the cause.
- **No reload** — switching re-applies runtime state in place; the next turn's prompt carries the new selection.

## Migrating from the launcher

```bash
pi-profile review          # before
pi --profile review        # after

pi-profile review -- --mode rpc   # before
pi --profile review --mode rpc    # after
```

`/profile reload` and the `/profile resource` commands are gone: skills are read on demand and catalogs are re-read on every use, so there is nothing to reload. Remove leftover `~/.pi/agent/pi-profile/runtime/` directories; the extension no longer creates them.

## Docs

- [Architecture](docs/architecture/overview.md) · [ADRs](docs/adr/) · [Glossary](CONTEXT.md) (Chinese)
- JSON Schema: [`schemas/profiles.schema.json`](schemas/profiles.schema.json)

## License

MIT
