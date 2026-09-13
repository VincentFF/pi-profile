/**
 * ProfilePresets: the starting points `/profile create` offers.
 *
 * A preset is DATA, not a profile. It never appears in `/profile list` and
 * cannot be activated until the create wizard copies it into a user catalog,
 * so `default` stays the only built-in profile and nothing here is ever
 * silently in effect. Once copied, the definition belongs to the user: the
 * preset is not tracked, and later changes to it do not reach existing
 * profiles.
 *
 * Every preset must work on a machine with no skills installed, no MCP
 * adapter, and no provider credentials:
 *
 * - no `mcp`: a declared MCP intent fails the whole activation when
 *   `pi-mcp-adapter` is absent or the server was never discovered
 *   (ADR-0002).
 * - no `model`: `provider` and `id` are required, and an unauthenticated
 *   model also fails the whole activation.
 * - no `skills`: a literal reference warns once the skill turns out to be
 *   missing, and `[]` hides every skill — omitting the field keeps Pi's full
 *   visibility.
 * - `tools` names Pi's built-in tools only, because extension and MCP tool
 *   names may never register, and it always contains `read`: Pi emits the
 *   prompt's skills section only while `read` or `bash` is active.
 * - `instructions` states behavior, never a capability name, and stays
 *   short: Pi appends it to the system prompt on every turn.
 *
 * `test/profile-presets.test.ts` enforces every rule above, asserts
 * `examples/profiles.json` is exactly this catalog, and asserts each preset
 * appears verbatim in `examples/profiles.example.json`.
 */

import type { ProfileDefinition } from "./profile-catalog.ts";

export interface ProfilePreset {
	/** Catalog key the create wizard offers as the new profile's name. */
	name: string;
	definition: ProfileDefinition;
}

/** The read-only behavior contract: describe, do not mutate. */
const READ_ONLY_INSTRUCTIONS = [
	"Read-only session: inspect and report; never create, edit, rename, or delete files.",
	"If a change is needed, describe it in your reply instead of applying it.",
	"Do not run commands that modify state (installs, formatters, commits, pushes, network writes).",
	"Prefer an available skill or MCP tool when it fits the request; otherwise use the tools you have.",
	"Ground claims in evidence: cite file:line and separate verified facts from inferences.",
	"Reply in English.",
].join("\n");

export const PROFILE_PRESETS: readonly ProfilePreset[] = [
	{
		name: "read-only",
		definition: {
			label: "Read-only",
			description: "Read-only session; no skills or MCP servers assumed — add your own.",
			tools: ["read", "grep", "find", "ls"],
			instructions: READ_ONLY_INSTRUCTIONS,
		},
	},
];
