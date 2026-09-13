/**
 * DefaultProfiles: the catalog a fresh install starts from.
 *
 * Pi packages have no install hook (docs/packages.md) — `pi install` only
 * unpacks the package and runs `npm install` — so "installing the default
 * profiles" can only happen the first time the extension actually loads.
 * `seedDefaultProfilesSync` therefore runs at load time, before any session
 * event, and is idempotent: an existing catalog file is never read, rewritten,
 * or backed up, and the package never seeds again once the file exists.
 *
 * The seeded content is the shipped preset catalog, exactly what
 * `examples/profiles.json` publishes, reached through the same
 * `PROFILE_PRESETS` data `/profile create` offers — one definition, so the
 * three cannot drift. The `read-only` profile declares built-in tools and
 * instructions only: it activates on a machine with no skills, no
 * `pi-mcp-adapter`, and no credentials, and it changes nothing until the
 * user selects it.
 *
 * `profile-presets.test.ts` pins the content contract: this catalog equals
 * the published `examples/profiles.json` and every definition is
 * resource-free.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { DEFAULT_PROFILE_NAME, PROFILE_SCHEMA_VERSION } from "./profile-catalog.ts";
import { PROFILE_PRESETS } from "./profile-presets.ts";

/** The catalog written to `<agentDir>/profiles.json` on first load. */
export const DEFAULT_PROFILE_CATALOG = {
	schemaVersion: PROFILE_SCHEMA_VERSION,
	profiles: Object.fromEntries(
		PROFILE_PRESETS.filter((preset) => preset.name !== DEFAULT_PROFILE_NAME).map((preset) => [
			preset.name,
			preset.definition,
		]),
	),
};

export type DefaultSeedResult =
	/** The agent dir had no catalog and now holds the default one. */
	| "seeded"
	/** A catalog file was already there; it was not touched. */
	| "present";

/**
 * Writes `<agentDir>/profiles.json` when it does not exist yet. Synchronous
 * on purpose: the load-time call site cannot await, and the write is one small
 * file. Existing files win unconditionally — an empty or hand-written catalog
 * is a user decision, not a missing default.
 */
export function seedDefaultProfilesSync(agentDir: string, catalog: unknown = DEFAULT_PROFILE_CATALOG): DefaultSeedResult {
	const target = path.join(agentDir, "profiles.json");
	if (existsSync(target)) return "present";
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(target, `${JSON.stringify(catalog, null, 2)}\n`);
	return "seeded";
}
