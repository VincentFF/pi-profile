/**
 * Overlay customize/reset orchestration (ticket 06).
 *
 * The overlay narrows the ACTIVE profile for this runtime only. It is
 * written to the scope state file (never a catalog) purely as the
 * persistence/status surface — the runtime effect flows through
 * re-resolution with the overlay, exactly like a switch. The launcher
 * ignores stored overlays, so an overlay never outlives its runtime.
 *
 * Ordering invariants:
 * - customize: re-resolve with the candidate overlay FIRST (validation:
 *   unknown references and alwaysOn protection fail here, before anything
 *   is written), then switch+reload, then persist the overlay to state. A
 *   failed switch leaves the stored overlay untouched, consistent with the
 *   rolled-back runtime.
 * - reset: switch+reload WITHOUT the overlay first, then delete it from
 *   state. If the switch rolls back, the stored overlay still matches the
 *   restored runtime.
 */

import path from "node:path";

import { RuntimeStateStore, type RuntimeOverlay, type RuntimeState } from "../runtime-state-store.ts";
import { getGlobalStateDir } from "../workspace.ts";
import { readLaunchPlanFile } from "./apply-plan.ts";
import { SwitchError, switchProfile, type SwitchDeps, type SwitchResult } from "./switch-profile.ts";

/** The scope state file for the currently active profile. */
async function currentStateTarget(
	deps: SwitchDeps,
): Promise<{ profile: string; store: RuntimeStateStore; state: RuntimeState }> {
	const plan = await readLaunchPlanFile(deps.runtimeDir);
	if (plan === undefined) {
		throw new SwitchError("no active profile — nothing to customize");
	}
	const stateDir = plan.source === "project" ? path.join(deps.cwd, ".pi") : getGlobalStateDir(plan.agentDir);
	if (stateDir === undefined) {
		throw new SwitchError("the launch plan carries no real agent dir — cannot locate the state file");
	}
	const store = new RuntimeStateStore(stateDir);
	return { profile: plan.profile, store, state: await store.read() };
}

/** Applies a mutation to the active profile's overlay and re-activates. */
export async function customizeOverlay(
	deps: SwitchDeps,
	mutate: (overlay: RuntimeOverlay) => RuntimeOverlay,
): Promise<SwitchResult> {
	const { profile, store, state } = await currentStateTarget(deps);
	const candidate = mutate(state.overlay ?? {});

	// switchProfile re-resolves with the candidate overlay; resolution-time
	// validation (unknown references, alwaysOn protection) fails before any
	// write. persistSelection is preserved by the reload-current path.
	const result = await switchProfile(profile, deps, { reloadCurrent: true, overlay: candidate });

	await store.update({ overlay: candidate });
	return result;
}

/** Discards the overlay and reactivates the profile exactly as declared. */
export async function resetOverlay(deps: SwitchDeps): Promise<SwitchResult> {
	const { profile, store } = await currentStateTarget(deps);

	// overlay: null — explicit "none"; without it the reload path would
	// re-apply the stored overlay we're discarding.
	const result = await switchProfile(profile, deps, { reloadCurrent: true, overlay: null });

	await store.update({ overlay: undefined });
	return result;
}

export const CUSTOMIZE_USAGE =
	"/profile customize disable|enable skill|extension|mcp <name> · /profile customize tools [ref...]" as const;

const DISABLED_FIELDS = {
	skill: "disabledSkills",
	extension: "disabledExtensions",
	mcp: "disabledMcp",
} as const;

/** Parses `/profile customize` arguments into an overlay mutation.
 *  Grammar:
 *    customize disable skill|extension|mcp <name>
 *    customize enable  skill|extension|mcp <name>   (un-disable)
 *    customize tools <ref>...                        (replace tool refs)
 *    customize tools                                  (clear the tools override)
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
	if ((action !== "disable" && action !== "enable") || field === undefined || rest.length !== 1) {
		throw new SwitchError(`usage: ${CUSTOMIZE_USAGE}`);
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
