# 01: Package shell, passthrough launcher, and default profile

**What to build:** The installable pi-profile-switch package: a launcher that resolves the initial profile, generates a pi-profile-switch-owned runtime directory, and spawns the real `pi` binary with user arguments passed through verbatim. With no positional argument the launcher starts the built-in `default` profile: the generated settings preserve the user's global settings untouched and re-include the real agent dir's resource dirs (their discovery root moves with `PI_CODING_AGENT_DIR`), plus symlinks to the user's real trust/auth/models/npm state — so behavior matches native `pi`, but the pi-profile-switch extension is loaded (`-e`) and the runtime directory is pi-profile-switch-owned, so in-session switching works uniformly from the start. This ticket establishes the package skeleton, build/test tooling, and the fixture layout convention all later tickets rely on.

Supersedes the earlier SDK-host implementation of this ticket (pre-ADR-0005): `profile-host.ts` and `resource-filter-adapter.ts` are deleted; args parsing is reworked from a whitelist to full passthrough.

**Blocked by:** None (can start immediately)

**Status:** done

- [x] Package builds and exposes both the `pi-profile` binary and the Pi extension entry; test runner and fixture layout exist so unit tests never require a real Pi process.
- [x] `pi-profile` with no profile argument spawns real `pi` with the `default` profile: integration (fixture dirs + real `pi --mode rpc` subprocess + RPC introspection) shows all fixture skills/extensions visible, matching native `pi`.
- [x] Everything after the first `--` reaches `pi` verbatim — arbitrary pi flags work (e.g. `--mode rpc`, `--continue`, `--no-session`); unsupported flags produce pi's own error, never a pi-profile whitelist error.
- [x] `--approve` / `--no-approve` are intercepted (parsed into a trust input). For the `default` profile the launcher deliberately re-applies them to `pi`, so project trust behavior stays native; non-`default` profiles will consume them in the resolver instead (ticket 03), never forwarding them blindly.
- [x] The generated runtime directory lives under a pi-profile-switch-owned location; user settings files are never rewritten (integration asserts the user's `settings.json` content is unchanged and new files in the real agent dir appear only inside pi-profile-switch-owned runtime dirs and pi's own session storage).
- [x] Launcher profile selection is transient: no runtime-state file is written.

## Comments

**2026-09-12 — completed** (commits `6c1aeab`…`da16b63`, pushed to `origin/main`)

Implemented under ADR-0005 (subprocess host + generated settings). The earlier SDK-host attempt on this ticket was superseded mid-flight and removed (`profile-host.ts`, `resource-filter-adapter.ts`). Dual-axis code-review findings were addressed in `da16b63`.

Verification: `tsc --noEmit` clean; `vitest run` 26/26 across 5 files, including integration against a real `pi --mode rpc` subprocess (fixture HOME/agent dir; RPC `get_commands` proves fixture skills and the fixture extension command are visible; user `settings.json` unchanged; new files in the real agent dir confined to `pi-profile/runtime` and `sessions`; unknown profile exits 2 before spawn; unknown pi flag reported by pi itself, not by a pi-profile whitelist).

Not verified: interactive TUI smoke (`node bin/pi-profile.ts` in a real terminal with model auth) — optional user check.
