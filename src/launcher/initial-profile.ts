/**
 * Initial profile resolution for the launcher.
 *
 * Flow: positional name or saved global state → catalog lookup → skill
 * discovery + resource registry → resolver (glob expansion, dependency
 * closure, alwaysOn, model validation) → ActivationPlan. Unknown profiles,
 * malformed catalogs/registries, and unresolvable resources all fail before
 * Pi is spawned.
 *
 * The CLI's initial selection is transient: no runtime state is written here.
 */

import { ProfileCatalog } from "../profile-catalog.ts";
import { defaultPlan, resolveProfile, type ActivationPlan } from "../profile-resolver.ts";
import { ResourceRegistry } from "../resource-registry.ts";
import { RuntimeStateStore } from "../runtime-state-store.ts";
import { discoverLauncherResources, type LauncherDiscovery } from "./discovery.ts";
import { checkDeclaredModel } from "./model-check.ts";

export class UnknownProfileError extends Error {
	constructor(name: string) {
		super(`unknown profile: ${name}`);
		this.name = "UnknownProfileError";
	}
}

export interface LauncherContext {
	/** The user's real agent dir (e.g. ~/.pi/agent). */
	agentDir: string;
	/** The project working directory Pi will run in. */
	cwd: string;
}

export interface InitialProfile {
	plan: ActivationPlan;
	/** Full discovery results for the settings generator. Undefined for the
	 *  default profile (which applies no filtering). */
	discovery?: LauncherDiscovery;
}

export async function resolveInitialProfile(
	name: string | undefined,
	context: LauncherContext,
): Promise<InitialProfile> {
	const catalog = await ProfileCatalog.load(context.agentDir);

	let selected = name;
	if (selected === undefined) {
		// No positional name: restore the saved active profile, falling back to
		// the built-in default. (Ticket 02: global state only.)
		selected = (await new RuntimeStateStore(context.agentDir).read()).activeProfile ?? "default";
	}

	const profile = catalog.resolve(selected);
	if (profile === undefined) {
		throw new UnknownProfileError(selected);
	}
	if (profile.source === "builtin") {
		return { plan: defaultPlan() };
	}

	const [discovery, resources] = await Promise.all([
		discoverLauncherResources(context),
		ResourceRegistry.load(context.agentDir),
	]);
	const plan = await resolveProfile({
		profile,
		skills: discovery.skills,
		resources,
		validateModel: (model) => checkDeclaredModel(context.agentDir, model),
	});
	return { plan, discovery };
}
