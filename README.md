# pi-profile-switch

[English](README.md) | [中文](README.zh-CN.md)

Named profiles for [Pi](https://github.com/badlogic/pi-mono). A profile selects what the model sees and which capabilities the session uses — skills, MCP servers, tools, a model preset, and extra instructions — switchable in the same Pi process.

A shipped `read-only` preset covers the read-and-report workflow; other workflows you write yourself — a profile can narrow the tool set, hide skills, pin a model, or add instructions.

`pi-profile-switch` is a plain Pi package (ADR-0007). It installs like any other extension, keeps Pi's configuration directory as the single source of truth, and keeps sessions, packages, project trust, and every other installed extension native. The only file it adds is the default catalog below.

## Install

```bash
pi install npm:pi-profile-switch
```

Requires [Pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) (installed automatically as a peer dependency).

Pi packages have no install hook, so the default catalog is written the first time the extension loads (in any mode, including `--mode rpc`): if `~/.pi/agent/profiles.json` does not exist, it is created from the shipped `read-only` profile. An existing file is never read, rewritten, or backed up — delete it to get the default back.

## Quick start

```bash
# Use the saved profile (or the built-in default)
pi

# Use a profile for this run only (not saved)
pi --profile read-only

# The explicit native baseline
pi --profile default
```

A fresh install already holds one profile, `read-only`; activate it with `pi --profile read-only` or `/profile use read-only`.

Create more with `/profile create`, which writes `~/.pi/agent/profiles.json` (global) or `<project>/.pi/profiles.json` (project, trusted projects only). The wizard offers the shipped `read-only` preset — Pi's built-in tools only, no skills, MCP servers, or model assumed — or a blank definition.

A preset is a one-time copy into your catalog: it is not tracked, so a package update never changes a profile you already created. Profiles **reference** resources by name — they never copy them. [`examples/profiles.example.json`](examples/profiles.example.json) is a complete catalog with several profiles covering every field; replace its resource names with ones you own.

`schemaVersion` is 1 and is the only accepted value. A profile cannot select extensions: they load natively in every profile, so manage them with `pi install`.

## What a profile controls

| Field | Effect |
| --- | --- |
| `instructions` | Text appended to the system prompt every turn |
| `model` | Session-start model preset; an explicit `--model`/`--thinking` or a model recorded in the session wins |
| `skills` | What the model sees in the prompt's skills list. Every installed skill stays loaded and callable by the user through `/skill:name` |
| `mcps` | Which MCP servers the session exposes: the profile's allowlist is written into the adapter's own config (`~/.pi/agent/mcp.json`), disabling every other server. Servers you keep in that file move to `mcp.user.json`; connection details stay in your config, never in the profile. The legacy key `mcp` is still read and becomes `mcps` the next time the profile is saved |
| `tools` | Active tool set: declared names/globs become the active set; names that register later (MCP, extensions) are applied when they appear |

Anything a profile does not declare keeps Pi's native behavior, and `default` declares nothing.

## Commands

In the TUI, the `/profile` command family manages everything in-session:

| Command | What it does |
| --- | --- |
| `/profile` | Interactive profile picker |
| `/profile list` / `/profile status` | Show profiles / active profile details |
| `/profile use <name>` | Switch in place — same session; when the MCP selection changes, the runtime reloads automatically to re-apply it |
| `/profile create\|edit\|delete\|duplicate` | Guided profile CRUD (TUI only) |
| `/profile customize` / `/profile reset` | Narrow the active profile for this session only |
| `/mcp enable\|disable <server>` | Toggle MCP servers in the active profile |

While a non-`default` profile is active, the footer shows `profile: <name>`, with `*` appended when a session-only overlay is in effect. `default` shows no badge, so an unprofiled session keeps Pi's native footer.

All commands work in non-interactive modes (`--mode rpc|print|json`); CRUD wizards are TUI-only.

## Guarantees

- **Reference, never copy** — profiles point at resources you already own and maintain.
- **Pi-native** — the configuration directory is Pi's own, so sessions, extension config, packages, context files, and trust behave exactly as they do in plain Pi.
- **Fail safe** — untrusted project directories are never read; a failed activation applies nothing and reports the cause.
- **No manual reload** — switching re-applies runtime state in place and the next turn's prompt carries the new selection. Only a change to the MCP selection rebuilds the runtime, automatically, in the same session, and the switch survives that rebuild: the rebuild continues the selection you made, it does not fall back to the profile you started with.

## Docs

- [Architecture](docs/architecture/overview.md) · [ADRs](docs/adr/) · [Glossary](CONTEXT.md) (Chinese)

## License

MIT
