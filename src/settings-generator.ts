/**
 * SettingsGenerator: materializes an ActivationPlan as a pi-profile-owned
 * runtime directory (ADR-0005).
 *
 * For the built-in `default` profile the generated settings preserve the
 * user's global settings untouched and re-include the real agent dir's
 * resource dirs (their discovery root moves with `PI_CODING_AGENT_DIR`), so
 * the spawned pi behaves exactly like native `pi`.
 *
 * For named profiles the generated settings encode the profile's selection
 * per the filtering model (see docs/architecture/overview.md):
 * - agentDir-scope resources: additive allowlist paths (the discovery root
 *   moved, so nothing auto-discovered from the real agent dir)
 * - `~/.agents` skills: always auto-discovered, so unselected ones are
 *   force-excluded with `-<path>` entries
 * - packages: user-configured package entries rewritten to object form with
 *   per-type allowlists (unmanaged types keep the user's key or Pi's default)
 * - `defaultProjectTrust: "never"` suppresses all project auto-discovery
 *   (project resources are gated by the resolver instead — ticket 03)
 * - unmanaged kinds (prompts, themes) pass through: the user's arrays are
 *   preserved and the real agent dir's prompts/themes dirs re-included
 * - tools/model become generated flags; the launch plan file feeds the
 *   in-pi extension (instructions injection, status)
 *
 * User configuration files are never modified.
 */

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import type { ActivationPlan } from "./profile-resolver.ts";
import type { SkillEntry } from "./skill-registry.ts";

/** A configured global package and its resolved install/local root. */
export interface ConfiguredPackageRoot {
	/** The source string exactly as written in the user's settings. */
	source: string;
	/** Absolute install/local root; undefined when not resolvable offline. */
	root?: string;
}

/** Full discovery results the generator needs beyond the plan itself:
 *  the complete skill set (for `~/.agents` exclusions) and configured
 *  package roots (for classifying extension entries). */
export interface DiscoveryContext {
	skills: SkillEntry[];
	packages: ConfiguredPackageRoot[];
}

export interface GenerateOptions {
	/** The user's real agent dir (e.g. ~/.pi/agent). */
	agentDir: string;
	/** Required for selection plans; unused for the default profile. */
	discovery?: DiscoveryContext;
	/** The trusted project's `.pi/settings.json` content (already parsed).
	 *  Only pass when the resolver's trust check passed; merged into the
	 *  generated base per Pi's merge rules for selection plans. Ignored for
	 *  the default profile (Pi reads project settings natively there). */
	projectSettings?: Record<string, unknown>;
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

/** State directories that must keep pointing at the real agent dir: package
 *  install roots (npm/git) and Pi's managed binaries (bin). */
const STATE_DIR_LINKS = ["npm", "git", "bin"] as const;

/** Resource dirs rooted at the real agent dir, re-included for the default
 *  profile because PI_CODING_AGENT_DIR moves the discovery root. */
const RESOURCE_DIR_KINDS = ["skills", "extensions", "prompts", "themes"] as const;

/** Unmanaged resource dirs re-included for every profile (pi-profile does
 *  not manage prompt templates or themes). */
const UNMANAGED_DIR_KINDS = ["prompts", "themes"] as const;

async function exists(filePath: string): Promise<boolean> {
	try {
		await stat(filePath);
		return true;
	} catch {
		return false;
	}
}

function toPosix(filePath: string): string {
	return filePath.split(path.sep).join("/");
}

/** Mirrors Pi's own deepMergeSettings: plain objects merge recursively,
 *  everything else (arrays, primitives) is replaced by the override. */
function deepMergeSettings(base: Record<string, unknown>, overrides: Record<string, unknown>): Record<string, unknown> {
	const result: Record<string, unknown> = { ...base };
	for (const [key, overrideValue] of Object.entries(overrides)) {
		if (overrideValue === undefined) continue;
		const baseValue = result[key];
		result[key] =
			isPlainObject(baseValue) && isPlainObject(overrideValue)
				? deepMergeSettings(baseValue, overrideValue)
				: overrideValue;
	}
	return result;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUnderPath(target: string, root: string): boolean {
	const relative = path.relative(root, target);
	return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

/** The HOME-level ~/.agents/skills dir: always auto-discovered by Pi,
 *  unsuppressible via PI_CODING_AGENT_DIR, so it needs exclusion entries. */
function homeAgentsSkillsDir(): string {
	return path.join(process.env.HOME ?? homedir(), ".agents", "skills");
}

function buildSelectionSettings(
	plan: ActivationPlan,
	userSettings: Record<string, unknown>,
	agentDir: string,
	discovery: DiscoveryContext,
): Record<string, unknown> {
	const settings = { ...userSettings };

	// --- skills ---
	// Project-scope selections are emitted before user-scope ones: Pi's
	// same-name collision rule is first-wins, and project resources must keep
	// their native priority (ticket 03).
	const orderedSelectedSkills = [...plan.skills].sort((a, b) => {
		const aProject = a.scope === "project" ? 0 : 1;
		const bProject = b.scope === "project" ? 0 : 1;
		return aProject - bProject;
	});
	const selectedPaths = new Set(plan.skills.map((skill) => skill.filePath));
	const skillEntries: string[] = [];
	for (const skill of orderedSelectedSkills) {
		if (skill.origin === "package") continue; // encoded in the packages allowlist
		if (isUnderPath(skill.filePath, homeAgentsSkillsDir())) continue; // auto-discovered anyway
		skillEntries.push(skill.filePath);
	}
	for (const skill of discovery.skills) {
		if (skill.origin === "package") continue;
		if (!isUnderPath(skill.filePath, homeAgentsSkillsDir())) continue;
		if (selectedPaths.has(skill.filePath)) continue;
		skillEntries.push(`-${skill.filePath}`);
	}
	settings.skills = skillEntries;

	// --- extensions ---
	// Entries under a package root are encoded in that package's allowlist;
	// everything else becomes an additive absolute path.
	const packageRoots = discovery.packages
		.filter((pkg): pkg is ConfiguredPackageRoot & { root: string } => pkg.root !== undefined)
		.map((pkg) => ({ ...pkg, root: pkg.root }));
	const packageExtensions = new Map<string, string[]>();
	const extensionEntries: string[] = [];
	for (const extension of plan.extensions) {
		const owner = packageRoots.find((pkg) => isUnderPath(extension.entry, pkg.root));
		if (owner === undefined) {
			extensionEntries.push(extension.entry);
		} else {
			const list = packageExtensions.get(owner.source) ?? [];
			list.push(toPosix(path.relative(owner.root, extension.entry)));
			packageExtensions.set(owner.source, list);
		}
	}
	settings.extensions = extensionEntries;

	// --- packages ---
	const userPackages = Array.isArray(userSettings.packages) ? userSettings.packages : [];
	if (userPackages.length > 0) {
		const packageSkills = new Map<string, string[]>();
		for (const skill of plan.skills) {
			if (skill.origin !== "package" || skill.baseDir === undefined) continue;
			const list = packageSkills.get(skill.source) ?? [];
			list.push(toPosix(path.relative(skill.baseDir, skill.filePath)));
			packageSkills.set(skill.source, list);
		}
		settings.packages = userPackages.map((pkg) => {
			const source = typeof pkg === "string" ? pkg : (pkg as { source: string }).source;
			const base: Record<string, unknown> =
				typeof pkg === "object" && pkg !== null ? { ...(pkg as Record<string, unknown>) } : { source };
			delete base.extensions;
			delete base.skills;
			const rewritten: Record<string, unknown> = {
				source,
				...base,
				skills: packageSkills.get(source) ?? [],
				extensions: packageExtensions.get(source) ?? [],
			};
			return rewritten;
		});
	}

	// --- unmanaged dirs pass through (prompts/themes) ---
	for (const kind of UNMANAGED_DIR_KINDS) {
		const resourceDir = path.join(agentDir, kind);
		if (existsSync(resourceDir)) {
			const entries = Array.isArray(settings[kind]) ? (settings[kind] as unknown[]) : [];
			settings[kind] = [...entries, resourceDir];
		}
	}

	// Project auto-discovery is suppressed entirely; the resolver gates
	// project resources (ticket 03).
	settings.defaultProjectTrust = "never";
	return settings;
}

export async function generateRuntimeDir(
	plan: ActivationPlan,
	options: GenerateOptions,
): Promise<GeneratedRuntime> {
	const { agentDir } = options;
	const runtimeRoot = path.join(agentDir, "pi-profile", "runtime");
	await mkdir(runtimeRoot, { recursive: true });
	const runtimeDir = await mkdtemp(path.join(runtimeRoot, "launch-"));

	const userSettingsPath = path.join(agentDir, "settings.json");
	const userSettings: Record<string, unknown> = (await exists(userSettingsPath))
		? JSON.parse(await readFile(userSettingsPath, "utf8"))
		: {};

	let settings: Record<string, unknown>;
	if (plan.filter === "none") {
		// default profile: the user's global settings plus re-inclusion of the
		// real agent dir's resource dirs. User-defined keys, including their own
		// resource patterns and enable/disable state, are preserved untouched.
		// Project settings are NOT merged here: with native trust behavior, Pi
		// reads the project's settings itself.
		settings = { ...userSettings };
		for (const kind of RESOURCE_DIR_KINDS) {
			const resourceDir = path.join(agentDir, kind);
			if (await exists(resourceDir)) {
				const entries = Array.isArray(settings[kind]) ? (settings[kind] as unknown[]) : [];
				settings[kind] = [...entries, resourceDir];
			}
		}
	} else {
		// Selection plans: the trusted project's settings merge into the base
		// per Pi's merge rules (project wins, nested objects merge), then the
		// filtering encoding replaces the managed keys on top. With
		// defaultProjectTrust: "never", Pi itself never reads project settings.
		const base =
			options.projectSettings !== undefined
				? deepMergeSettings(userSettings, options.projectSettings)
				: { ...userSettings };
		settings = buildSelectionSettings(plan, base, agentDir, options.discovery ?? { skills: [], packages: [] });
	}
	await writeFile(path.join(runtimeDir, "settings.json"), `${JSON.stringify(settings, null, 2)}\n`);

	// The launch plan feeds the in-pi extension (instructions injection now;
	// switching/status in later tickets).
	await writeFile(
		path.join(runtimeDir, "pi-profile.json"),
		`${JSON.stringify(
			{
				profile: plan.profile,
				source: plan.source,
				...(plan.instructions !== undefined ? { instructions: plan.instructions } : {}),
				...(plan.model !== undefined ? { model: plan.model } : {}),
				...(plan.tools !== undefined ? { tools: plan.tools } : {}),
			},
			null,
			2,
		)}\n`,
	);

	// Keep auth/model state in the real agent dir, so the spawned pi shares
	// credentials and model catalogs with native pi. trust.json is only
	// linked for the default profile: a stored trust decision beats the
	// generated defaultProjectTrust: "never" inside Pi, so named profiles must
	// not expose it — the launcher reads the real trust.json itself and is the
	// sole trust gatekeeper (ADR-0005).
	for (const name of STATE_FILE_LINKS) {
		if (name === "trust.json" && plan.filter !== "none") continue;
		const target = path.join(agentDir, name);
		if (await exists(target)) {
			await symlink(target, path.join(runtimeDir, name));
		}
	}
	for (const name of STATE_DIR_LINKS) {
		const target = path.join(agentDir, name);
		if (await exists(target)) {
			await symlink(target, path.join(runtimeDir, name), "dir");
		}
	}

	const flags: string[] = [];
	if (plan.filter === "selection") {
		if (plan.tools !== undefined) {
			flags.push("--tools", plan.tools.join(","));
		}
		if (plan.model !== undefined) {
			// Pi's native shorthand: --model <provider/id[:thinking]>.
			const modelFlag = `${plan.model.provider}/${plan.model.id}`;
			flags.push("--model", plan.model.thinkingLevel !== undefined ? `${modelFlag}:${plan.model.thinkingLevel}` : modelFlag);
		}
	}

	return {
		runtimeDir,
		env: {
			PI_CODING_AGENT_DIR: runtimeDir,
			PI_CODING_AGENT_SESSION_DIR: path.join(agentDir, "sessions"),
		},
		flags,
	};
}
