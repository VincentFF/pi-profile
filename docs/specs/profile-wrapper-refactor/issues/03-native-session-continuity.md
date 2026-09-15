# 03: Native session continuity and session directory linking

**What to build:**
Unified session management that connects each profile instance directly to native Pi session storage. Inside each profile instance, `<instance>/agent/sessions` is symlinked to `~/.pi/agent/sessions`, and `PI_CODING_AGENT_SESSION_DIR` is set to `~/.pi/agent/sessions`. The wrapper CLI forwards all session-related flags (`-c`, `-r`, `--session`, `--fork`, `--name`) directly to `pi`. Users can start a session in native `pi` and seamlessly continue it with `pi-profile <name> -c`, or switch between profiles without losing session history.

**Blocked by:** 02: Full-fidelity symlink mirroring of `~/.pi/agent`

**Status:** resolved

- [ ] Instance `agent/sessions` is explicitly symlinked to `~/.pi/agent/sessions`.
- [ ] Environment variable `PI_CODING_AGENT_SESSION_DIR` is set to the canonical path of `~/.pi/agent/sessions`.
- [ ] Running `pi-profile <name> -c` successfully continues the most recent session from `~/.pi/agent/sessions`.
- [ ] Running `pi-profile <name> -r` opens the native session picker displaying all project sessions.
- [ ] New sessions initiated from `pi-profile` write directly into `~/.pi/agent/sessions/<project-slug>/`.
- [ ] Integration test verifies that a session created by native `pi` can be resumed and appended to by `pi-profile`.
