/**
 * StartupSelection: how a session decides which profile to activate.
 *
 * - `--profile <name>` (a flag this extension registers) is an explicit,
 *   one-run selection: it is never written back to runtime state.
 * - Without the flag the saved selection applies: the trusted project's
 *   state wins over the global state, then the built-in `default`.
 * - A saved selection that no longer resolves falls back to `default` with
 *   a warning — restore is a convenience, not a commitment. An explicit
 *   flag value never falls back: an unknown name is a loud error.
 *
 * Explicit CLI declarations (`--model`, `--thinking`, `--tools`,
 * `--exclude-tools`) outrank the profile's matching declaration. They are
 * detected by re-parsing this process's argv with Pi's own exported parser,
 * so the aliases and value forms stay Pi's rather than a hand-rolled copy.
 */

import { parseArgs } from "@earendil-works/pi-coding-agent";
import { stat } from "node:fs/promises";
import path from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { DEFAULT_PROFILE_NAME, ProfileCatalog } from "./profile-catalog.ts";
import { RuntimeStateStore } from "./runtime-state-store.ts";

/** Which settings the user stated on the command line this run. */
export interface ExplicitDeclarations {
	model: boolean;
	thinking: boolean;
	tools: boolean;
}

export const PROFILE_FLAG = "profile";

/** Registers the `--profile <name>` CLI flag. Pi has no flag of that name;
 *  unknown flags are collected by its parser and validated against flags
 *  registered by loaded extensions. */
export function registerProfileFlag(pi: ExtensionAPI): void {
	pi.registerFlag(PROFILE_FLAG, {
		type: "string",
		description: "pi-profile-switch: activate a profile for this run (not saved)",
	});
}

/** The `--profile` value, when the user passed one. */
export function readProfileFlag(pi: ExtensionAPI): string | undefined {
	const value = pi.getFlag(PROFILE_FLAG);
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Detects explicit CLI declarations by re-parsing argv with Pi's parser. */
export function detectExplicitDeclarations(argv: string[]): ExplicitDeclarations {
	const parsed = parseArgs(argv);
	return {
		model: parsed.model !== undefined,
		thinking: parsed.thinking !== undefined,
		tools: parsed.tools !== undefined || parsed.excludeTools !== undefined,
	};
}

export interface StartupProfile {
	name: string;
	/** Non-fatal notices (e.g. a saved profile that no longer exists). */
	warnings: string[];
}

async function exists(filePath: string): Promise<boolean> {
	try {
		await stat(filePath);
		return true;
	} catch {
		return false;
	}
}

/** Files the retired extension registry lived in; they are no longer read
 *  (ADR-0007), and a leftover file is called out once per startup. */
async function legacyRegistryWarnings(input: {
	agentDir: string;
	cwd: string;
	projectTrusted: boolean;
}): Promise<string[]> {
	const candidates = [path.join(input.agentDir, "resources.json")];
	if (input.projectTrusted) candidates.push(path.join(input.cwd, ".pi", "resources.json"));
	const warnings: string[] = [];
	for (const filePath of candidates) {
		if (await exists(filePath)) {
			warnings.push(
				`${filePath} is no longer read (ADR-0007): extensions load natively in every profile — manage them with pi install`,
			);
		}
	}
	return warnings;
}

/** Resolves the profile name for this session: explicit flag → trusted
 *  project state → global state → default. Never writes state. */
export async function resolveStartupProfile(input: {
	agentDir: string;
	cwd: string;
	projectTrusted: boolean;
	requested?: string;
}): Promise<StartupProfile> {
	const catalog = await ProfileCatalog.load(input.agentDir, {
		projectDir: input.projectTrusted ? input.cwd : undefined,
	});
	const warnings: string[] = [
		...catalog.warnings,
		...(await legacyRegistryWarnings(input)),
	];

	if (input.requested !== undefined) {
		if (catalog.resolve(input.requested) === undefined) {
			throw new UnknownProfileError(input.requested, catalog.list().map((profile) => profile.name));
		}
		return { name: input.requested, warnings };
	}

	let saved: string | undefined;
	if (input.projectTrusted) {
		saved = (await new RuntimeStateStore(path.join(input.cwd, ".pi")).read()).activeProfile;
	}
	saved ??= (await new RuntimeStateStore(input.agentDir).read()).activeProfile;

	if (saved === undefined || saved === DEFAULT_PROFILE_NAME) {
		return { name: DEFAULT_PROFILE_NAME, warnings };
	}
	if (catalog.resolve(saved) === undefined) {
		warnings.push(
			`saved profile ${JSON.stringify(saved)} no longer exists — starting with "${DEFAULT_PROFILE_NAME}"; ` +
				`available: [${catalog.list().map((profile) => profile.name).join(", ")}]`,
		);
		return { name: DEFAULT_PROFILE_NAME, warnings };
	}
	return { name: saved, warnings };
}

export class UnknownProfileError extends Error {
	readonly requested: string;

	constructor(requested: string, available: string[]) {
		super(`unknown profile ${JSON.stringify(requested)} — available: [${available.join(", ")}]`);
		this.name = "UnknownProfileError";
		this.requested = requested;
	}
}
