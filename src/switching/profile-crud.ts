/**
 * ProfileCrud: `/profile create|edit|delete|duplicate` semantics (ticket 09)
 * on top of ProfileCatalogStore.
 *
 * Invariants:
 * - Trust-gated exactly like activation: an untrusted project's catalog is
 *   never read or written.
 * - Deleting the ACTIVE profile requires a replacement up front — the
 *   session must land somewhere defined; the caller switches to it.
 * - Deleting one scope's record while the other scope keeps the name
 *   reveals that definition (merged-catalog semantics; nothing extra to
 *   do beyond reloading).
 * - Duplicating copies the COMPLETE definition under a new name — the
 *   only variant mechanism (no inheritance).
 */

import path from "node:path";

import { CatalogError, DEFAULT_PROFILE_NAME, type ProfileDefinition } from "../profile-catalog.ts";
import { ProfileCatalogStore } from "../profile-catalog-store.ts";

export type CatalogScope = "global" | "project";

/** The caller's trust decision (`ctx.isProjectTrusted()`) plus the two
 *  directories scope files live in. */
export interface CatalogInput {
	realAgentDir: string;
	cwd: string;
	projectTrusted: boolean;
}

/** The store for one scope's catalog file — the ONLY place scope-file
 *  paths are constructed. Callers must still trust-gate project access
 *  (`requireScope` / `readCatalogScope`). */
export function catalogStore(input: CatalogInput, scope: CatalogScope): ProfileCatalogStore {
	return new ProfileCatalogStore(
		scope === "global" ? path.join(input.realAgentDir, "profiles.json") : path.join(input.cwd, ".pi", "profiles.json"),
	);
}

function requireScope(input: CatalogInput, scope: CatalogScope): void {
	if (scope === "project" && !input.projectTrusted) {
		throw new CatalogError(`project catalog is unavailable: ${input.cwd} is not trusted`);
	}
}

/** Reads one scope's catalog with the trust gate applied — project reads
 *  return empty when untrusted (never touching the file). */
export async function readCatalogScope(
	input: CatalogInput,
	scope: CatalogScope,
): Promise<Map<string, ProfileDefinition>> {
	if (scope === "project" && !input.projectTrusted) {
		return new Map();
	}
	return catalogStore(input, scope).readDefinitions();
}

/** Creates a complete definition in the chosen scope. */
export async function createProfile(
	input: CatalogInput,
	scope: CatalogScope,
	name: string,
	definition: ProfileDefinition,
): Promise<void> {
	requireScope(input, scope);
	const store = catalogStore(input, scope);
	if ((await store.readDefinitions()).has(name)) {
		throw new CatalogError(`profile "${name}" already exists in the ${scope} catalog`);
	}
	await store.upsert(name, definition);
}

/** Replaces a complete definition; the caller reloads iff it is active. */
export async function editProfile(
	input: CatalogInput,
	scope: CatalogScope,
	name: string,
	definition: ProfileDefinition,
): Promise<void> {
	requireScope(input, scope);
	if (name === DEFAULT_PROFILE_NAME) {
		throw new CatalogError(`"${DEFAULT_PROFILE_NAME}" is built in and cannot be edited`);
	}
	const store = catalogStore(input, scope);
	if (!(await store.readDefinitions()).has(name)) {
		throw new CatalogError(`profile "${name}" not found in the ${scope} catalog`);
	}
	await store.upsert(name, definition);
}

/**
 * Deletes a profile from the chosen scope. Deleting the active profile
 * requires `replacement` (validated for existence in the remaining merged
 * catalog by the caller's switch); the built-in default can never be
 * deleted.
 */
export async function deleteProfile(
	input: CatalogInput,
	scope: CatalogScope,
	name: string,
	options: { activeProfile?: string; replacement?: string },
): Promise<void> {
	requireScope(input, scope);
	if (name === DEFAULT_PROFILE_NAME) {
		throw new CatalogError(`"${DEFAULT_PROFILE_NAME}" is built in and cannot be deleted`);
	}
	if (options.activeProfile === name && options.replacement === undefined) {
		throw new CatalogError(`profile "${name}" is active — choose a replacement profile first`);
	}
	await catalogStore(input, scope).remove(name);
}

/** Copies a complete definition under a new, unused name. */
export async function duplicateProfile(
	input: CatalogInput,
	scope: CatalogScope,
	sourceName: string,
	newName: string,
): Promise<void> {
	requireScope(input, scope);
	const store = catalogStore(input, scope);
	const definitions = await store.readDefinitions();
	const source = definitions.get(sourceName);
	if (source === undefined) {
		throw new CatalogError(`profile "${sourceName}" not found in the ${scope} catalog`);
	}
	if (definitions.has(newName)) {
		throw new CatalogError(`profile "${newName}" already exists in the ${scope} catalog`);
	}
	await store.upsert(newName, { ...source });
}
