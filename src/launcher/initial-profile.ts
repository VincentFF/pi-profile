/**
 * Initial profile resolution for the launcher.
 *
 * Flow: trust check (gatekeeper for everything project-scoped) → positional
 * name or saved state (project state wins when trusted) → catalog lookup →
 * skill discovery + resource registry → resolver (glob expansion, dependency
 * closure, alwaysOn, model validation) → ActivationPlan + full discovery
 * results for the settings generator. Unknown profiles, malformed
 * catalogs/registries, and unresolvable resources all fail before Pi spawns.
 *
 * The CLI's initial selection is transient: no runtime state is written here.
 */

import path from "node:path";

import { isRecord, readJsonFile } from "../json-file.ts";
import { ProfileCatalog } from "../profile-catalog.ts";
import { defaultPlan, resolveProfile, type ActivationPlan } from "../profile-resolver.ts";
import { resolveProjectTrust } from "../project-trust.ts";
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
	/** One-run trust input from --approve / --no-approve (never forwarded to Pi). */
	trustOverride?: boolean;
}

export interface InitialProfile {
	plan: ActivationPlan;
	/** Full discovery results for the settings generator. Undefined for the
	 *  default profile (which applies no filtering). */
	discovery?: LauncherDiscovery;
	/** The trusted project's `.pi/settings.json` content, when trusted and
	 *  present. The generator merges it into the base for selection plans. */
	projectSettings?: Record<string, unknown>;
}

/** Reads the real global `defaultProjectTrust` setting (a trust input) and,
 *  when trusted, the project's `.pi/settings.json`. */
async function readTrustInputs(context: LauncherContext): Promise<{
	projectTrusted: boolean;
	projectSettings?: Record<string, unknown>;
}> {
	const globalSettingsPath = path.join(context.agentDir, "settings.json");
	const globalSettings = await readJsonFile(globalSettingsPath);
	const userDefaultProjectTrust =
		globalSettings.ok && isRecord(globalSettings.value) && typeof globalSettings.value.defaultProjectTrust === "string"
			? globalSettings.value.defaultProjectTrust
			: undefined;
	const projectTrusted = resolveProjectTrust({
		cwd: context.cwd,
		agentDir: context.agentDir,
		trustOverride: context.trustOverride,
		userDefaultProjectTrust,
	});
	if (!projectTrusted) {
		return { projectTrusted };
	}
	const projectSettingsResult = await readJsonFile(path.join(context.cwd, ".pi", "settings.json"));
	const projectSettings =
		projectSettingsResult.ok && isRecord(projectSettingsResult.value) ? projectSettingsResult.value : undefined;
	return { projectTrusted, projectSettings };
}

export async function resolveInitialProfile(
	name: string | undefined,
	context: LauncherContext,
): Promise<InitialProfile> {
	const { projectTrusted, projectSettings } = await readTrustInputs(context);
	const projectDir = projectTrusted ? context.cwd : undefined;
	const catalog = await ProfileCatalog.load(context.agentDir, { projectDir });

	let selected = name;
	if (selected === undefined) {
		// No positional name: the trusted project's saved selection is the more
		// specific one and wins; otherwise the global state, then default.
		if (projectTrusted) {
			selected = (await new RuntimeStateStore(path.join(context.cwd, ".pi")).read()).activeProfile;
		}
		selected ??= (await new RuntimeStateStore(context.agentDir).read()).activeProfile ?? "default";
	}

	const profile = catalog.resolve(selected);
	if (profile === undefined) {
		throw new UnknownProfileError(selected);
	}
	if (profile.source === "builtin") {
		return { plan: defaultPlan() };
	}

	const [discovery, resources] = await Promise.all([
		discoverLauncherResources({ ...context, projectTrusted }),
		ResourceRegistry.load(context.agentDir, { projectDir }),
	]);
	const plan = await resolveProfile({
		profile,
		skills: discovery.skills,
		resources,
		validateModel: (model) => checkDeclaredModel(context.agentDir, model),
	});
	return { plan, discovery, projectSettings };
}
