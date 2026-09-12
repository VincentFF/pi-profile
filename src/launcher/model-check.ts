/**
 * Pre-spawn validation for a profile's declared model (ticket 02).
 *
 * Mirrors Pi's own session preflight: the model must resolve against the
 * user's real model catalog (built-ins + models.json custom providers), and
 * the provider must have configured auth (stored credential, static key, or
 * ambient source). A missing or unauthenticated declared model fails
 * activation before Pi is spawned, so a session never runs on an unexpected
 * model.
 *
 * Note: Pi deliberately accepts unlisted model IDs under a known provider
 * (custom/self-hosted models), so an unknown *provider* is the hard failure.
 */

import path from "node:path";

import { ModelRuntime, resolveCliModel } from "@earendil-works/pi-coding-agent";

import type { ProfileModel } from "../profile-catalog.ts";

/** Returns an error message, or undefined when the model exists and is
 *  authenticated. Reads the user's real agent dir state; never writes. */
export async function checkDeclaredModel(agentDir: string, model: ProfileModel): Promise<string | undefined> {
	const runtime = await ModelRuntime.create({
		authPath: path.join(agentDir, "auth.json"),
		modelsPath: path.join(agentDir, "models.json"),
		modelsStorePath: path.join(agentDir, "models-store.json"),
		refreshOnCreate: false,
		allowModelNetwork: false,
	});
	const resolved = resolveCliModel({ cliModel: `${model.provider}/${model.id}`, modelRuntime: runtime });
	if (resolved.error !== undefined) {
		return resolved.error;
	}
	// resolveCliModel fuzzy-matches partial IDs; a stored profile must resolve
	// to exactly the declared model (Pi's custom-model-id fallback also yields
	// the declared ID verbatim, so exactness is compatible with it).
	if (
		resolved.model === undefined ||
		resolved.model.id !== model.id ||
		resolved.model.provider.toLowerCase() !== model.provider.toLowerCase()
	) {
		return `model not found: ${model.provider}/${model.id}`;
	}
	const authenticated =
		runtime.hasConfiguredAuth(resolved.model.provider) ||
		(await runtime.checkAuth(resolved.model.provider)) !== undefined;
	if (!authenticated) {
		return `no credentials configured for provider "${resolved.model.provider}"`;
	}
	return undefined;
}
