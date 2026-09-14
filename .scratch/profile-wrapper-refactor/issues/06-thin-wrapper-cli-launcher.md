# 06: Thin wrapper CLI launcher and process forwarding

**What to build:**
The primary command-line entrypoint `pi-profile` that acts as the thin wrapper shell:
- Resolves the requested profile name (or falls back to `default`).
- Prepares and updates the instance directory at `~/.pi-profile-switch/instances/<profile-name>/agent`.
- Spawns the native `pi` executable with `PI_CODING_AGENT_DIR` set to the instance directory and `PI_CODING_AGENT_SESSION_DIR` set to `~/.pi/agent/sessions`.
- Forwards all additional CLI flags (e.g. `-c`, `-r`, `--mode`, `-p`, `--model`) verbatim to `pi`.
- Connects standard I/O in `inherit` mode to ensure full TUI, raw terminal, and stream compatibility.
- Propagates Unix signals (`SIGINT`, `SIGTERM`) and exits with the child process's exact exit code.

**Blocked by:** 03: Native session continuity and session directory linking, 05: Per-profile extension and skill filtering in generated settings

**Status:** ready-for-agent

- [ ] Command `pi-profile [profile-name] [pi-args...]` correctly isolates the profile name and forwards remaining arguments.
- [ ] Running `pi-profile` without arguments resolves and launches the `default` profile.
- [ ] Child process is spawned with `PI_CODING_AGENT_DIR` pointing to the profile's instance directory.
- [ ] Child process inherits stdio cleanly for interactive TUI, print mode, and RPC mode.
- [ ] Signal handling ensures Ctrl+C (`SIGINT`) and termination (`SIGTERM`) terminate the child cleanly without orphaning processes.
- [ ] Wrapper exits with the identical return code of the spawned `pi` process.
- [ ] Fast startup: if the instance directory already matches the profile definition, launch without unnecessary file writes.
