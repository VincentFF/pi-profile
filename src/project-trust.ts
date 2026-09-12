/**
 * Project trust resolution for the launcher — pi-profile is the sole
 * gatekeeper for project resources, because generated settings carry
 * `defaultProjectTrust: "never"` and Pi therefore never auto-discovers them.
 *
 * Mirrors Pi's own trust decision order (`resolveProjectTrusted`):
 *   1. one-run `--approve` / `--no-approve` override (consumed by the
 *      launcher, never forwarded for named profiles)
 *   2. the stored decision in the real `trust.json` (nearest ancestor wins)
 *   3. the user's `defaultProjectTrust` setting — but only "always" grants;
 *      "ask" cannot prompt here (the launcher has no trust UI), so it falls
 *      through to untrusted
 *   4. otherwise untrusted: project catalogs, registries, resources, and
 *      state files are not read at all
 */

import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";

export interface ProjectTrustInput {
	cwd: string;
	agentDir: string;
	/** One-run override from --approve (true) / --no-approve (false). */
	trustOverride?: boolean;
	/** The user's real global `defaultProjectTrust` setting. */
	userDefaultProjectTrust?: string;
}

export function resolveProjectTrust(input: ProjectTrustInput): boolean {
	if (input.trustOverride !== undefined) {
		return input.trustOverride;
	}
	const stored = new ProjectTrustStore(input.agentDir).get(input.cwd);
	if (stored !== null) {
		return stored;
	}
	return input.userDefaultProjectTrust === "always";
}
