#!/usr/bin/env node
/**
 * postinstall: seed the global catalog with the default profiles file.
 *
 * Runs at package install time (`npm install pi-profile` / `pi install`).
 * Idempotent and conservative:
 * - Writes `defaults/profiles.json` to the profile-switch dir ONLY when no
 *   catalog exists there yet (COPYFILE_EXCL; an existing file — including
 *   one written concurrently — is never touched).
 * - Skips entirely when a legacy `~/.pi/agent/profiles.json` exists, because
 *   the resolver still falls back to it and a new preferred-path file would
 *   silently shadow it (see src/workspace.ts resolveGlobalProfilesPath).
 * - Never fails the install: errors are downgraded to a warning.
 *
 * This module is plain Node ESM (no jiti/TS): npm may run postinstall in a
 * context where only plain JS is safe. The path rules intentionally mirror
 * src/workspace.ts — keep them in sync.
 */
import { access, copyFile, mkdir } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const DEFAULT_TEMPLATE = fileURLToPath(new URL("../defaults/profiles.json", import.meta.url));

/** Mirrors getProfileSwitchDir() in src/workspace.ts.
 *  @param {NodeJS.ProcessEnv} env */
function profileSwitchDir(env) {
	const override = env.PI_PROFILE_SWITCH_DIR;
	if (override && override.trim()) return path.resolve(override.trim());
	return path.join(homedir(), ".pi-profile-switch");
}

/** The legacy migration fallback the resolver still reads (~/.pi/agent).
 *  @param {NodeJS.ProcessEnv} env */
function legacyCatalogPath(env) {
	const agentDir = env.PI_CODING_AGENT_DIR ?? path.join(homedir(), ".pi", "agent");
	return path.join(agentDir, "profiles.json");
}

/** @param {string} filePath */
async function exists(filePath) {
	try {
		await access(filePath);
		return true;
	} catch {
		return false;
	}
}

/** @typedef {{ path: string, written: boolean, skipped?: string }} InstallResult */

/**
 * Seeds the default catalog. Safe to call repeatedly; only the first call
 * writes.
 * @param {{ env?: NodeJS.ProcessEnv }} [options]
 * @returns {Promise<InstallResult>}
 */
export async function installDefaultProfiles({ env = process.env } = {}) {
	const target = path.join(profileSwitchDir(env), "profiles.json");
	if (await exists(target)) return { path: target, written: false };
	if (await exists(legacyCatalogPath(env))) {
		return { path: target, written: false, skipped: "legacy-catalog-present" };
	}
	await mkdir(path.dirname(target), { recursive: true });
	try {
		await copyFile(DEFAULT_TEMPLATE, target, constants.COPYFILE_EXCL);
	} catch (error) {
		// Lost a create race (e.g. two installs in parallel): the winner's
		// file stands; still not ours to overwrite.
		if (error.code === "EEXIST") return { path: target, written: false };
		throw error;
	}
	return { path: target, written: true };
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
	installDefaultProfiles().then(
		(result) => {
			if (result.written) console.log(`pi-profile: seeded default profiles at ${result.path}`);
		},
		(error) => {
			console.warn(`pi-profile: could not seed default profiles: ${error instanceof Error ? error.message : error}`);
		},
	);
}
