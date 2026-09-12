/**
 * SettingsGenerator: materializes an ActivationPlan as a pi-profile-owned
 * runtime directory (ADR-0005).
 *
 * For the built-in `default` profile the generated settings are a verbatim
 * copy of the user's global settings — no filtering, native trust behavior —
 * plus symlinks back to the user's real trust/auth/models/npm state, so the
 * spawned pi behaves exactly like native `pi` while the runtime directory
 * stays pi-profile-owned (which is what later in-session switching rewrites).
 *
 * User configuration files are never modified.
 */

import { mkdir, mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";

import type { ActivationPlan } from "./launcher/initial-profile.ts";

export interface GenerateOptions {
	/** The user's real agent dir (e.g. ~/.pi/agent). */
	agentDir: string;
}

export interface GeneratedRuntime {
	/** The generated runtime directory (becomes PI_CODING_AGENT_DIR). */
	runtimeDir: string;
	/** Environment variables for the spawned pi process. */
	env: Record<string, string>;
	/** Extra pi flags derived from the plan (e.g. --tools, --model). Empty for default. */
	flags: string[];
}

/** State files that must keep pointing at the user's real agent dir. */
const STATE_FILE_LINKS = ["trust.json", "auth.json", "models.json", "models-store.json"] as const;

/** Resource dirs rooted at the real agent dir, re-included for the default
 *  profile because PI_CODING_AGENT_DIR moves the discovery root. */
const RESOURCE_DIR_KINDS = ["skills", "extensions", "prompts", "themes"] as const;

async function exists(filePath: string): Promise<boolean> {
	try {
		await stat(filePath);
		return true;
	} catch {
		return false;
	}
}

export async function generateRuntimeDir(
	plan: ActivationPlan,
	options: GenerateOptions,
): Promise<GeneratedRuntime> {
	const { agentDir } = options;
	const runtimeRoot = path.join(agentDir, "pi-profile", "runtime");
	await mkdir(runtimeRoot, { recursive: true });
	const runtimeDir = await mkdtemp(path.join(runtimeRoot, "launch-"));

	// default profile: the user's global settings plus re-inclusion of the
	// real agent dir's resource dirs (their discovery root moved with
	// PI_CODING_AGENT_DIR). User-defined keys, including their own resource
	// patterns and enable/disable state, are preserved untouched.
	const userSettingsPath = path.join(agentDir, "settings.json");
	const userSettings: Record<string, unknown> = (await exists(userSettingsPath))
		? JSON.parse(await readFile(userSettingsPath, "utf8"))
		: {};
	if (plan.filter === "none") {
		for (const kind of RESOURCE_DIR_KINDS) {
			const resourceDir = path.join(agentDir, kind);
			if (await exists(resourceDir)) {
				const entries = Array.isArray(userSettings[kind]) ? (userSettings[kind] as unknown[]) : [];
				userSettings[kind] = [...entries, resourceDir];
			}
		}
	}
	await writeFile(path.join(runtimeDir, "settings.json"), `${JSON.stringify(userSettings, null, 2)}\n`);

	// Keep trust/auth/model state in the real agent dir, so the spawned pi
	// shares credentials, trust decisions, and model catalogs with native pi.
	for (const name of STATE_FILE_LINKS) {
		const target = path.join(agentDir, name);
		if (await exists(target)) {
			await symlink(target, path.join(runtimeDir, name));
		}
	}
	const npmDir = path.join(agentDir, "npm");
	if (await exists(npmDir)) {
		await symlink(npmDir, path.join(runtimeDir, "npm"), "dir");
	}

	return {
		runtimeDir,
		env: {
			PI_CODING_AGENT_DIR: runtimeDir,
			PI_CODING_AGENT_SESSION_DIR: path.join(agentDir, "sessions"),
		},
		flags: plan.filter === "none" ? [] : [],
	};
}
