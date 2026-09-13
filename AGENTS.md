# pi-profile

This repo contains two things:

1. **The pi-profile package** (the product): a Pi package that adds named profiles selecting skills, extensions, MCP servers, and tools for a Pi runtime, switchable without restarting Pi. Greenfield: the package source is not created yet; build it from the docs below.
2. **The owner's vendored pi skills** in `.agents/skills/` (installed from `mattpocock/skills`, locked by `skills-lock.json`). Workflow tooling, not product code.

## Design principles

1. **Pi compatibility first**: never change Pi's default behavior unless strictly necessary. Profiles ride Pi's native discovery, settings, and reload mechanisms; anything a profile does not explicitly control stays Pi-native, so Pi and other Pi packages keep working unchanged.
2. **User experience first, minimal like Pi**: Pi is minimalist by design; pi-profile must match it. Minimize configuration surface and ceremony — prefer discovery over registration, defaults over required fields, and actionable errors over bare failures.

## Product docs

- Product requirements (Chinese): `docs/product/prd.md`. Read before changing behavior, scope, commands, or config semantics.
- Architecture (Chinese): `docs/architecture/overview.md`. Module interfaces, data contracts, activation flow, package layout. Read before creating source files.
- Domain glossary: `CONTEXT.md`. Hard-to-reverse decisions: `docs/adr/`. If output contradicts an ADR, surface it explicitly.

## Issue tracker

Issues and specs are tracked as local Markdown files under `docs/specs/` (one directory per feature). See `docs/agents/issue-tracker.md`.

## Triage labels

Default vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

## Domain docs

Single-context: one `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.
