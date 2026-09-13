# pi-profile-switch

[English](README.md) | [中文](README.zh-CN.md)

Named profiles for [Pi](https://github.com/badlogic/pi-mono). A profile selects what the model sees and which capabilities the session uses — skills, MCP servers, tools, a model preset, and extra instructions — switchable in the same Pi process.

A shipped `read-only` preset covers the read-and-report workflow; other workflows you write yourself — a profile can narrow the tool set, hide skills, pin a model, or add instructions.

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
pi --profile read-only

# The explicit native baseline
pi --profile default
```

Create profiles with `/profile create`, which writes `~/.pi/agent/profiles.json` (global) or `<project>/.pi/profiles.json` (project, trusted projects only). The wizard offers the shipped `read-only` preset — Pi's built-in tools only, no skills, MCP servers, or model assumed — or a blank definition:

```json
{
  "schemaVersion": 1,
  "profiles": {
    "read-only": {
      "label": "Read-only",
      "description": "Read-only session; no skills or MCP servers assumed — add your own.",
      "tools": [
        "read",
        "grep",
        "find",
        "ls"
      ],
      "instructions": "Read-only session: inspect and report; never create, edit, rename, or delete files.\nIf a change is needed, describe it in your reply instead of applying it.\nDo not run commands that modify state (installs, formatters, commits, pushes, network writes).\nPrefer an available skill or MCP tool when it fits the request; otherwise use the tools you have.\nGround claims in evidence: cite file:line and separate verified facts from inferences.\nReply in English."
    }
  }
}
```

A preset is a one-time copy into your catalog: it is not tracked, so a package update never changes a profile you already created. Profiles **reference** resources by name — they never copy them. [`examples/profiles.json`](examples/profiles.json) is that same preset as a catalog; the field reference is [`schemas/profiles.schema.json`](schemas/profiles.schema.json).

`schemaVersion` is 1. A profile cannot select extensions: they load natively in every profile, so manage them with `pi install`.

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

While a non-`default` profile is active, the footer shows `profile: <name>`, with `*` appended when a session-only overlay is in effect. `default` shows no badge, so an unprofiled session keeps Pi's native footer.

All commands work in non-interactive modes (`--mode rpc|print|json`); CRUD wizards are TUI-only.

## Guarantees

- **Reference, never copy** — profiles point at resources you already own and maintain.
- **Pi-native** — the configuration directory is Pi's own, so sessions, extension config, packages, context files, and trust behave exactly as they do in plain Pi.
- **Fail safe** — untrusted project directories are never read; a failed activation applies nothing and reports the cause.
- **No reload** — switching re-applies runtime state in place; the next turn's prompt carries the new selection.

## Docs

- [Architecture](docs/architecture/overview.md) · [ADRs](docs/adr/) · [Glossary](CONTEXT.md) (Chinese)
- JSON Schema: [`schemas/profiles.schema.json`](schemas/profiles.schema.json)

## License

MIT
