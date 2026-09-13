# pi-profile-switch

This repo contains two things:

1. **The pi-profile-switch package** (the product): a Pi package that adds named profiles selecting skills, extensions, MCP servers, and tools for a Pi runtime, switchable without restarting Pi. Greenfield: the package source is not created yet; build it from the docs below.
2. **The owner's vendored pi skills** in `.agents/skills/` (installed from `mattpocock/skills`, locked by `skills-lock.json`). Workflow tooling, not product code.

## Design principles

1. **Pi compatibility first**: never change Pi's default behavior unless strictly necessary. Profiles ride Pi's native discovery, settings, and reload mechanisms; anything a profile does not explicitly control stays Pi-native, so Pi and other Pi packages keep working unchanged.
2. **User experience first, minimal like Pi**: Pi is minimalist by design; pi-profile-switch must match it. Minimize configuration surface and ceremony — prefer discovery over registration, defaults over required fields, and actionable errors over bare failures.

## Product docs

- Product requirements (Chinese): `docs/product/prd.md`. Read before changing behavior, scope, commands, or config semantics.
- Architecture (Chinese): `docs/architecture/overview.md`. Module interfaces, data contracts, activation flow, package layout. Read before creating source files.
- Domain glossary: `CONTEXT.md`. Hard-to-reverse decisions: `docs/adr/`. If output contradicts an ADR, surface it explicitly.

## Issue tracker

Issues and specs are tracked as local Markdown files under `docs/specs/` (one directory per feature). See `docs/agents/issue-tracker.md`.

## Branches and releases

`main` is protected: changes land only through a squash-merged PR, and the PR title becomes the commit message that release-please reads. Work on `feat/<slug>` or `fix/<slug>` branches. A PR title is a Conventional Commit — `fix:` and `deps:` release a patch, `feat:` a minor, every other type releases nothing — and the major version is named by hand with a `Release-As: <version>` footer as the last paragraph of the PR body. Merging a PR on `main` updates a release PR; merging that one tags and publishes to npm. Full rules, including one-time setup: `CONTRIBUTING.md`.

## Triage labels

Default vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

## Domain docs

Single-context: one `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.
