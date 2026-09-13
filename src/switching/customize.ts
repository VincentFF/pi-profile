/**
 * Overlay customize/reset orchestration.
 *
 * The overlay narrows the ACTIVE profile for this runtime only. It is
 * written to the scope state file (never a catalog) as persistence and the
 * status surface; the runtime effect flows through re-resolution with the
 * overlay, exactly like a switch. Startup activation ignores stored
 * overlays, so an overlay never outlives its runtime.
 *
 * Ordering invariants:
 * - customize: activate with the candidate overlay FIRST (validation:
 *   unknown references fail here, before anything is written), then persist
 *   the overlay to state. A failed activation leaves the stored overlay
 *   untouched.
 * - reset: activate without the overlay first, then delete it from state.
 */


import type { ProfileSource } from "../profile-catalog.ts";
import { RuntimeStateStore, stateDirFor, type RuntimeOverlay } from "../runtime-state-store.ts";
import { activateProfile, ActivationError, type ActivationDeps, type ActivationResult } from "./activate-profile.ts";

export interface OverlayTarget {
	profile: { name: string; source: ProfileSource };
}

/** Applies a mutation to the active profile's overlay and re-activates. */
export async function customizeOverlay(
	deps: ActivationDeps & OverlayTarget,
	mutate: (overlay: RuntimeOverlay) => RuntimeOverlay,
): Promise<ActivationResult> {
	const stateDir = stateDirFor(deps.profile.source, deps);
	const stored = (await new RuntimeStateStore(stateDir).read()).overlay ?? {};
	const candidate = mutate(stored);
	// activateProfile re-resolves with the candidate and persists it
	// (overlay in the state update) — validation fails before any write.
	return activateProfile(deps.profile.name, deps, { overlay: candidate, persist: true });
}

/** Discards the overlay and reactivates the profile exactly as declared. */
export async function resetOverlay(deps: ActivationDeps & OverlayTarget): Promise<ActivationResult> {
	return activateProfile(deps.profile.name, deps, { overlay: null, persist: true });
}

export const CUSTOMIZE_USAGE =
	"/profile customize disable|enable skill|mcp <name> · /profile customize tools [ref...]" as const;

const DISABLED_FIELDS = {
	skill: "disabledSkills",
	mcp: "disabledMcp",
} as const;

/** Parses `/profile customize` arguments into an overlay mutation.
 *  Grammar:
 *    customize disable skill|mcp <name>
 *    customize enable  skill|mcp <name>   (un-disable)
 *    customize tools <ref>...             (replace tool refs)
 *    customize tools                      (clear the tools override)
 */
export function parseCustomizeArgs(args: string): (overlay: RuntimeOverlay) => RuntimeOverlay {
	const [action, kind, ...rest] = args.trim().split(/\s+/).filter(Boolean);

	if (action === "tools") {
		const refs = [kind, ...rest].filter((entry): entry is string => entry !== undefined);
		return (overlay) => {
			const next = { ...overlay };
			if (refs.length === 0) delete next.tools;
			else next.tools = refs;
			return next;
		};
	}

	const field = DISABLED_FIELDS[kind as keyof typeof DISABLED_FIELDS];
	if (field === undefined || (action !== "disable" && action !== "enable") || rest.length !== 1) {
		throw new ActivationError(`usage: ${CUSTOMIZE_USAGE}`);
	}
	const [name] = rest;
	return (overlay) => {
		const current = overlay[field] ?? [];
		const nextList =
			action === "disable" ? [...new Set([...current, name])] : current.filter((entry) => entry !== name);
		const next = { ...overlay };
		if (nextList.length === 0) delete next[field];
		else next[field] = nextList;
		return next;
	};
}
