/**
 * ResourceCrud: `/profile resource list|create|edit|delete` semantics
 * (ticket 08) on top of ResourceRegistryStore.
 *
 * Invariants:
 * - Trust-gated exactly like activation: an untrusted project's registry
 *   and catalogs are invisible (never read).
 * - Deletion is refused while ANY profile (either scope, shadowed or not —
 *   a shadowed global profile still activates in other projects) or any
 *   other resource's `dependsOn` references the entry. The refusal names
 *   the referrers.
 * - Mutations land in exactly one scope file (global or project); the
 *   caller applies them through the standard rewrite-settings-and-reload
 *   path.
 */

import path from "node:path";

import { readTrustInputs } from "../launcher/initial-profile.ts";
import { ProfileCatalog } from "../profile-catalog.ts";
import { RegistryError, type ResourceEntry } from "../resource-registry.ts";
import { ResourceRegistryStore } from "../resource-registry-store.ts";

export type RegistryScope = "global" | "project";

export interface RegistryListEntry extends ResourceEntry {
	source: RegistryScope;
	shadowsGlobal: boolean;
}

function storeFor(input: { realAgentDir: string; cwd: string }, scope: RegistryScope): ResourceRegistryStore {
	return new ResourceRegistryStore(
		scope === "global" ? path.join(input.realAgentDir, "resources.json") : path.join(input.cwd, ".pi", "resources.json"),
	);
}

async function projectTrusted(input: { realAgentDir: string; cwd: string }): Promise<boolean> {
	return (await readTrustInputs({ agentDir: input.realAgentDir, cwd: input.cwd })).projectTrusted;
}

/** Trust-gated merged listing; project entries override same-ID global ones. */
export async function listRegistryEntries(input: {
	realAgentDir: string;
	cwd: string;
}): Promise<RegistryListEntry[]> {
	const globalEntries = await storeFor(input, "global").readEntries();
	const merged = new Map<string, RegistryListEntry>();
	for (const entry of globalEntries.values()) {
		merged.set(entry.id, { ...entry, source: "global", shadowsGlobal: false });
	}
	if (await projectTrusted(input)) {
		for (const entry of (await storeFor(input, "project").readEntries()).values()) {
			merged.set(entry.id, { ...entry, source: "project", shadowsGlobal: globalEntries.has(entry.id) });
		}
	}
	return [...merged.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/** Every visible profile or registry entry referencing `id`. */
export async function findReferrers(input: { realAgentDir: string; cwd: string }, id: string): Promise<string[]> {
	const referrers: string[] = [];
	const trusted = await projectTrusted(input);
	// Scan BOTH scopes: a shadowed global profile still activates in other
	// projects, so its references keep the entry alive. Global-only load
	// covers every global profile; the merged load contributes the project
	// winners (deduped by label for non-shadowed globals).
	const catalogs = [await ProfileCatalog.load(input.realAgentDir)];
	if (trusted) {
		catalogs.push(await ProfileCatalog.load(input.realAgentDir, { projectDir: input.cwd }));
	}
	const seen = new Set<string>();
	for (const catalog of catalogs) {
		for (const profile of catalog.list()) {
			if (!(profile.definition.extensions ?? []).includes(id)) continue;
			const label = `profile "${profile.name}" (${profile.source})`;
			if (!seen.has(label)) {
				seen.add(label);
				referrers.push(label);
			}
		}
	}
	for (const scope of trusted ? (["global", "project"] as const) : (["global"] as const)) {
		for (const entry of (await storeFor(input, scope).readEntries()).values()) {
			if (entry.id !== id && entry.dependsOn.includes(id)) {
				referrers.push(`resource "${entry.id}" dependsOn (${scope})`);
			}
		}
	}
	return referrers.sort();
}

/** Refuses deletion while referenced; otherwise removes from the scope file. */
export async function deleteRegistryEntry(
	input: { realAgentDir: string; cwd: string },
	scope: RegistryScope,
	id: string,
): Promise<void> {
	if (scope === "project" && !(await projectTrusted(input))) {
		throw new RegistryError(`project registry is unavailable: ${input.cwd} is not trusted`);
	}
	const referrers = await findReferrers(input, id);
	if (referrers.length > 0) {
		throw new RegistryError(`cannot delete resource "${id}": referenced by ${referrers.join(", ")}`);
	}
	await storeFor(input, scope).remove(id);
}

/** Validates + upserts into the chosen scope file (kind is always "extension"). */
export async function upsertRegistryEntry(
	input: { realAgentDir: string; cwd: string },
	scope: RegistryScope,
	entry: { id: string; entry: string; dependsOn?: string[]; alwaysOn?: boolean },
): Promise<void> {
	if (scope === "project" && !(await projectTrusted(input))) {
		throw new RegistryError(`project registry is unavailable: ${input.cwd} is not trusted`);
	}
	await storeFor(input, scope).upsert(entry);
}
