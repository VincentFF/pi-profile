# pi-profile

[English](README.md) | [中文](README.zh-CN.md)

Named profiles for [Pi](https://github.com/badlogic/pi-mono). A profile references a set of existing skills, extensions, MCP servers, and tools — switch between them in the same Pi process, without restarting.

Use a lean read-only profile for code review, a full-powered one for implementation, a minimal one for a quick question — all against the same installed resources.

## Install

```bash
npm install -g pi-profile
```

Requires [Pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) (installed automatically as a peer dependency).

## Quick start

```bash
# Launch with the built-in default profile (all resources, plain Pi behavior)
pi-profile

# Launch with a named profile
pi-profile review

# Anything after -- is passed to pi verbatim
pi-profile review -- --model openai/gpt-5.4
```

Define profiles in `~/.pi-profile-switch/profiles.json` (global, fallback to `~/.pi/agent/profiles.json` for migration; custom root via `PI_PROFILE_SWITCH_DIR`) or `<project>/.pi/profiles.json` (project, trusted projects only):

```json
{
  "schemaVersion": 1,
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

Profiles **reference** resources by name — they never copy them. Installed packages and files in standard locations are discovered automatically; no registration needed. Full schema with more examples: [`examples/profiles.json`](examples/profiles.json).

On install, pi-profile seeds `~/.pi-profile-switch/profiles.json` with a starter **`ask`** profile — read-only Q&A and code exploration (`read`/`grep`/`find`/`ls`, no skills, extensions, or MCP). It assumes nothing about your setup; edit or delete it freely.

## Commands

In the TUI, the `/profile` command family manages everything in-session:

| Command | What it does |
| --- | --- |
| `/profile` | Interactive profile picker |
| `/profile list` / `/profile status` | Show profiles / active profile details |
| `/profile use <name>` / `/profile reload` | Switch / reload without restarting (rollback on failure) |
| `/profile create\|edit\|delete\|duplicate` | Guided profile CRUD (TUI only) |
| `/profile resource create\|edit\|delete` | Guided resource overrides |
| `/profile customize` / `/profile reset` | Narrow the active profile for this session only |
| `/mcp enable\|disable <server>` | Toggle MCP servers in the active profile |

All commands work in non-interactive modes (`--mode rpc|print|json`); CRUD wizards are TUI-only.

## Guarantees

- **Reference, never copy** — profiles point at resources you already own and maintain.
- **Pi-native** — anything a profile doesn't explicitly control keeps plain Pi behavior.
- **Fail safe** — untrusted project directories are never read; a failed switch rolls back to the last working configuration.

## Docs

- [Architecture](docs/architecture/overview.md) · [ADRs](docs/adr/) · [Glossary](CONTEXT.md) (Chinese)
- JSON Schemas: [`schemas/`](schemas/)

## License

MIT
