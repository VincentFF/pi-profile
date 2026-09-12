# 12: Release artifacts and acceptance

**What to build:** Ship the package: published JSON schemas for both catalog files, worked examples, README usage docs, and package metadata declaring both the extension and the binary. The PRD's 8-step manual TUI acceptance flow is documented and reproducible by a fresh user, and the full unit and integration suites are green.

**Blocked by:** 01–11 (all preceding tickets)

**Status:** ready-for-agent

- [ ] Both JSON schemas ship with the package and validate the shipped examples.
- [ ] README documents launcher usage (`pi-profile`, `pi-profile <name>`, full `--` passthrough), the `/profile` command family, and the no-inheritance / reference-not-copy invariants.
- [ ] Package metadata exposes both the Pi extension and the `pi-profile` binary; install and launch work from a clean environment against the real `pi` binary.
- [ ] All unit seams (catalog, registries, resolver, settings generator, MCP coordination, state store) and the integration suite (real pi subprocess, per the PRD's integration acceptance) pass.
- [ ] The PRD's 8-step TUI acceptance scenario is documented and passes as a manual checklist.
