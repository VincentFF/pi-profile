# Profiles reference shared resources, never copy them

A profile references resources by name — skill names, extension resource IDs, MCP server names, tool names — and never copies them. One implementation exists per resource, shared by all referencing profiles; edits to a `SKILL.md`, extension, or MCP server propagate to every profile on the next start or reload.

Considered alternative: self-contained profiles with vendored resource copies. Rejected because it forks implementations (fixing a skill would mean editing N copies) and breaks the principle that users own and maintain their resources directly. This is the core design invariant; do not introduce per-profile resource copies.
