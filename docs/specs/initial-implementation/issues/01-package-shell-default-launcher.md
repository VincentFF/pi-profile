# 01: Package shell, passthrough launcher, and default profile

**What to build:** The installable pi-profile package: a launcher that resolves the initial profile, generates a pi-profile-owned runtime directory, and spawns the real `pi` binary with user arguments passed through verbatim. With no positional argument the launcher starts the built-in `default` profile: the generated settings are a verbatim copy of the user's global settings plus symlinks to the user's real trust/auth/models/npm state, so behavior matches native `pi` — but the pi-profile extension is loaded (`-e`) and the runtime directory is pi-profile-owned, so in-session switching works uniformly from the start. This ticket establishes the package skeleton, build/test tooling, and the fixture layout convention all later tickets rely on.

Supersedes the earlier SDK-host implementation of this ticket (pre-ADR-0005): `profile-host.ts` and `resource-filter-adapter.ts` are deleted; args parsing is reworked from a whitelist to full passthrough.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] Package builds and exposes both the `pi-profile` binary and the Pi extension entry; test runner and fixture layout exist so unit tests never require a real Pi process.
- [ ] `pi-profile` with no profile argument spawns real `pi` with the `default` profile: integration (fixture dirs + real `pi --mode rpc` subprocess + RPC introspection) shows all fixture skills/extensions visible, matching native `pi`.
- [ ] Everything after the first `--` reaches `pi` verbatim — arbitrary pi flags work (e.g. `--mode rpc`, `--continue`, `--no-session`); unsupported flags produce pi's own error, never a pi-profile whitelist error.
- [ ] `--approve` / `--no-approve` are intercepted by the launcher (never forwarded); for the `default` profile, project trust behavior stays native.
- [ ] The generated runtime directory lives under a pi-profile-owned location; user settings files are never rewritten (integration asserts zero changes in the fixture's real agent dir).
- [ ] Launcher profile selection is transient: no runtime-state file is written.
