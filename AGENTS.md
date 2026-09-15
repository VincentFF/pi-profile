# pi-profile-switch

This repo contains **the pi-profile-switch package**: a Pi package that adds named profiles selecting skills, extensions, MCP servers, and tools for a Pi runtime, switchable without restarting Pi.

## Design principles

1. **Pi compatibility first**: never change Pi's default behavior unless strictly necessary. Profiles ride Pi's native discovery, settings, and reload mechanisms; anything a profile does not explicitly control stays Pi-native, so Pi and other Pi packages keep working unchanged.
2. **User experience first, minimal like Pi**: Pi is minimalist by design; pi-profile-switch must match it. Minimize configuration surface and ceremony — prefer discovery over registration, defaults over required fields, and actionable errors over bare failures.

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
