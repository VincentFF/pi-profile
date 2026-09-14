/**
 * Workspace management for pi-profile-switch.
 *
 * Rooted at `~/.pi-profile-switch` (or `PI_PROFILE_SWITCH_DIR` override).
 * Contains:
 * - `profiles.json`: global profile definitions catalog
 * - `instances/`: instance runtime directories for forked pi processes
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export function getProfileSwitchDir(): string {
	const env = process.env.PI_PROFILE_SWITCH_DIR;
	if (env && env.trim()) {
		return path.resolve(env.trim());
	}
	return path.join(homedir(), ".pi-profile-switch");
}

export function getGlobalProfilesPath(): string {
	return path.join(getProfileSwitchDir(), "profiles.json");
}

export function resolveGlobalProfilesPath(agentDir: string): string {
	const preferred = getGlobalProfilesPath();
	if (existsSync(preferred)) {
		return preferred;
	}
	// Fallback for legacy ~/.pi/agent/profiles.json
	const fallback = path.join(agentDir, "profiles.json");
	if (existsSync(fallback)) {
		return fallback;
	}
	return preferred;
}

export function getInstancesRootDir(): string {
	return path.join(getProfileSwitchDir(), "instances");
}
