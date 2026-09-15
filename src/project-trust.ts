/**
 * Project trust resolution for the launcher — pi-profile is the sole
 * gatekeeper for project resources, because generated settings carry
 * `defaultProjectTrust: "never"` and Pi therefore never auto-discovers them.
 *
 * Mirrors Pi's own trust decision order (`resolveProjectTrusted`), with
 * pi-profile's catalog/registry/state files added to the trust-requiring
 * resource set (they are pi-profile's project attack surface; Pi doesn't
 * know about them):
 *   1. one-run `--approve` / `--no-approve` override (consumed by the
 *      launcher, never forwarded for named profiles)
 *   2. a project with no trust-requiring resources at all is trusted —
 *      there is nothing project-scoped to gate
 *   3. the stored decision in the real `trust.json` (nearest ancestor wins)
 *   4. the user's `defaultProjectTrust` setting — but only "always" grants;
 *      "ask" cannot prompt here (the launcher has no trust UI), so it falls
 *      through to untrusted
 *   5. otherwise untrusted: project catalogs, registries, resources, and
 *      state files are not read at all
 *
 * Known divergence from Pi: extension `project_trust` event handlers are not
 * consulted — that would require executing extension code in the launcher,
 * which pi-profile never does. In named-profile sessions the event is moot
 * anyway (generated settings carry `defaultProjectTrust: "never"`).
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { hasTrustRequiringProjectResources, ProjectTrustStore } from "@earendil-works/pi-coding-agent";

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
	if (!hasTrustRequiringProjectResources(input.cwd) && !hasPiProfileProjectFiles(input.cwd)) {
		return true;
	}
	let stored = new ProjectTrustStore(input.agentDir).get(input.cwd);
	if (stored === null) {
		// Defensive fallback for raw/symlinked entries in trust.json
		// that ProjectTrustStore's canonicalizePath missed.
		try {
			const trustFile = path.join(input.agentDir, "trust.json");
			if (existsSync(trustFile)) {
				const content = JSON.parse(readFileSync(trustFile, "utf8"));
				if (typeof content === "object" && content !== null) {
					let curr: string | undefined = path.resolve(input.cwd);
					while (curr && curr !== path.dirname(curr)) {
						if (content[curr] === true || content[curr] === false) {
							stored = content[curr];
							break;
						}
						curr = path.dirname(curr);
					}
				}
			}
		} catch {}
	}
	if (stored !== null) {
		return stored;
	}
	return input.userDefaultProjectTrust === "always";
}

/** pi-profile's own project files are trust-requiring even though Pi's
 *  native list doesn't know them: a committed catalog/state file would
 *  otherwise inject profile definitions (and instructions) unguarded. */
function hasPiProfileProjectFiles(cwd: string): boolean {
	return ["profiles.json", "pi-profile-state.json"].some((name) =>
		existsSync(path.join(cwd, ".pi", name)),
	);
}
