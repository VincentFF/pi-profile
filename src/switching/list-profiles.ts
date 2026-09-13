/**
 * ProfileListing: the `/profile list` and `/profile` selector data surface.
 *
 * Trust-gated exactly like activation: an untrusted project's profiles are
 * invisible. The listing reports each visible profile with the source of
 * the WINNING definition (a same-name project definition fully replaces the
 * global one — the shadowed global entry is reported as such).
 */

import { ProfileCatalog, type ProfileSource } from "../profile-catalog.ts";

export interface ProfileListEntry {
	name: string;
	/** The source of the winning definition. */
	source: ProfileSource;
	label?: string;
	description?: string;
	/** True when a global definition of the same name is shadowed by the
	 *  project one. */
	shadowsGlobal: boolean;
}

export async function listProfiles(input: {
	realAgentDir: string;
	cwd: string;
	projectTrusted: boolean;
}): Promise<{ entries: ProfileListEntry[]; warnings: string[] }> {
	const catalog = await ProfileCatalog.load(input.realAgentDir, {
		projectDir: input.projectTrusted ? input.cwd : undefined,
	});
	return {
		entries: catalog.list().map((profile) => ({
			name: profile.name,
			source: profile.source,
			...(typeof profile.definition.label === "string" ? { label: profile.definition.label } : {}),
			...(typeof profile.definition.description === "string" ? { description: profile.definition.description } : {}),
			shadowsGlobal: profile.source === "project" && catalog.shadowsGlobal(profile.name),
		})),
		warnings: [...catalog.warnings],
	};
}

export function formatProfileList(entries: ProfileListEntry[], activeProfile?: string): string {
	if (entries.length === 0) {
		return "no profiles found";
	}
	return entries
		.map((entry) => {
			const active = entry.name === activeProfile ? " ← active" : "";
			const shadowed = entry.shadowsGlobal ? " (shadows global)" : "";
			const label = entry.label ?? entry.description;
			return `${entry.name} [${entry.source}]${shadowed}${label !== undefined ? ` — ${label}` : ""}${active}`;
		})
		.join("\n");
}
