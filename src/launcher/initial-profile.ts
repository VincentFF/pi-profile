/**
 * Initial profile resolution for the launcher.
 *
 * Ticket 01: only the built-in `default` profile exists. Named profiles from
 * the global/project catalogs arrive with the catalog tickets; until then a
 * positional name fails loudly instead of silently starting unfiltered.
 */

/** Immutable, fully resolved activation set. Grows with the resolver tickets. */
export interface ActivationPlan {
	profile: string;
	/**
	 * "none" = expose everything Pi can discover (the default profile).
	 * Filtering kinds arrive with named-profile support.
	 */
	filter: "none";
}

export class UnknownProfileError extends Error {
	constructor(name: string) {
		super(`unknown profile: ${name} (only the built-in "default" profile exists for now)`);
		this.name = "UnknownProfileError";
	}
}

export function resolveInitialProfile(name: string | undefined): ActivationPlan {
	const profile = name ?? "default";
	if (profile !== "default") {
		throw new UnknownProfileError(profile);
	}
	return { profile, filter: "none" };
}
