# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those roles to the `Status:` values used in this repo's local Markdown tracker (`docs/specs/`).

| Label in mattpocock/skills | Status value in our tracker | Meaning                                 |
| -------------------------- | -------------------- | ---------------------------------------- |
| `needs-triage`             | `needs-triage`       | Maintainer needs to evaluate this issue  |
| `needs-info`               | `needs-info`         | Waiting on reporter for more information |
| `ready-for-agent`          | `ready-for-agent`    | Fully specified, ready for an AFK agent  |
| `ready-for-human`          | `ready-for-human`    | Requires human implementation            |
| `wontfix`                  | `wontfix`            | Will not be actioned                     |
| _(tracker-local)_          | `done`               | Completed and verified; all acceptance criteria checked |

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), write the corresponding value as a `Status:` line near the top of the file.

`done` is not a mattpocock triage role — it is this tracker's local completion state. Set it when every acceptance criterion in the file is verified, and append a completion note (date, commits, verification evidence, anything left unverified) under a `## Comments` heading.

Edit the right-hand column to match whatever vocabulary you actually use.
