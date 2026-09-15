/**
 * SettingsGenerator: materializes an ActivationPlan as a pi-profile-owned
 * runtime directory (ADR-0005).
 *
 * Two entry points:
 * - `generateRuntimeDir` (launcher): mkdtemp a fresh runtime dir, write the
 *   files, link state (auth/models/mcp/npm/git/bin; trust.json only for
 *   default), derive env + flags.
 * - `writeRuntimeFiles` (in-session switch, ticket 05): rewrite
 *   settings.json + pi-profile.json inside the EXISTING runtime dir (the
 *   running process's PI_CODING_AGENT_DIR cannot move), and transition the
 *   trust.json link to match the new plan's filter mode.
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
 *   (project resources enter only through the trust-gated resolver)
 * - project `packages` are stripped from the settings merge (project
 *   packages are unsupported — the key would install into the global npm
 *   root as a launch side effect)
 * - unmanaged kinds (prompts, themes) pass through: the user's arrays are
 *   preserved and the real agent dir's prompts/themes dirs re-included
 * - tools/model become generated flags; the launch plan file feeds the
 *   in-pi extension (instructions injection, status)
 *
 * User configuration files are never modified.
 */

import { existsSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, lstat, readdir, readFile, readlink, rm, stat, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import type { ActivationPlan } from "./profile-resolver.ts";
import { getInstancesRootDir } from "./workspace.ts";
import { isRecord } from "./json-file.ts";
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

/** Files managed explicitly by pi-profile in runtimeDir; excluded from auto-symlinking. */
export const MANAGED_INSTANCE_FILES = new Set([
	"settings.json",
	"mcp.json",
	"APPEND_SYSTEM.md",
	"pi-profile.json",
	"trust.json",
	"pid",
	"extensions",
]);

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
			isRecord(baseValue) && isRecord(overrideValue)
				? deepMergeSettings(baseValue, overrideValue)
				: overrideValue;
	}
	return result;
}

function tryRealpath(p: string): string {
	try {
		return realpathSync(p);
	} catch {
		return path.resolve(p);
	}
}

function isUnderPath(target: string, root: string): boolean {
	const relative = path.relative(root, target);
	if (relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)) {
		return true;
	}
	const normRelative = path.relative(tryRealpath(root), tryRealpath(target));
	return normRelative !== "" && !normRelative.startsWith("..") && !path.isAbsolute(normRelative);
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
	runtimeDir: string,
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
		if (selectedPaths.has(skill.filePath)) continue;
		
		// If the skill is in the real agentDir, Pi will discover it via the symlink.
		// We must exclude the symlink path so Pi actually excludes it.
		if (isUnderPath(skill.filePath, agentDir)) {
			const rel = path.relative(tryRealpath(agentDir), tryRealpath(skill.filePath));
			skillEntries.push(`-${path.join(runtimeDir, rel)}`);
		} else {
			skillEntries.push(`-${skill.filePath}`);
		}
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

	// --- profile defaults (Ticket 04) ---
	if (plan.model !== undefined) {
		settings.defaultProvider = plan.model.provider;
		settings.defaultModel = plan.model.id;
		if (plan.model.thinkingLevel !== undefined) {
			settings.defaultThinkingLevel = plan.model.thinkingLevel;
		} else {
			delete settings.defaultThinkingLevel;
		}
	}
	if (plan.tools !== undefined) {
		settings.defaultTools = plan.tools;
	}

	// Project auto-discovery is suppressed entirely; selected project
	// resources enter additively through the trust-gated resolver.
	settings.defaultProjectTrust = "never";
	return settings;
}

export interface RuntimeFileOptions {
	/** The user's real agent dir (e.g. ~/.pi/agent). */
	agentDir: string;
	/** Required for selection plans; unused for the default profile. */
	discovery?: DiscoveryContext;
	/** The trusted project's `.pi/settings.json` content (already parsed). */
	projectSettings?: Record<string, unknown>;
	/** Extra launch-plan fields written by the in-session switch path:
	 *  `switchedFrom` triggers the one-shot change summary; `persistSelection`
	 *  tells the post-reload extension instance to save the selection and
	 *  record the rollback anchor; `clearOverlay` drops the stored overlay
	 *  (a profile switch discards the previous profile's overlay).
	 *  `previousResolved` carries the pre-switch resolved name sets so
	 *  `/profile status` can report glob deltas (ticket 07). */
	planExtras?: {
		switchedFrom?: string;
		persistSelection?: boolean;
		clearOverlay?: boolean;
		previousResolved?: ResolvedNames;
	};
}

/** Computes the generated settings for a plan (pure-ish: reads the user's
 *  real settings + unmanaged dir existence, writes nothing). */
async function computeSettings(
	plan: ActivationPlan,
	options: RuntimeFileOptions,
	runtimeDir: string,
): Promise<Record<string, unknown>> {
	const { agentDir } = options;
	const userSettingsPath = path.join(agentDir, "settings.json");
	const userSettings: Record<string, unknown> = (await exists(userSettingsPath))
		? JSON.parse(await readFile(userSettingsPath, "utf8"))
		: {};

	if (plan.filter === "none") {
		// default profile: the user's global settings plus re-inclusion of the
		// real agent dir's resource dirs. User-defined keys, including their own
		// resource patterns and enable/disable state, are preserved untouched.
		// Project settings are NOT merged here: with native trust behavior, Pi
		// reads the project's settings itself.
		const settings = { ...userSettings };
		for (const kind of RESOURCE_DIR_KINDS) {
			const resourceDir = path.join(agentDir, kind);
			if (await exists(resourceDir)) {
				const entries = Array.isArray(settings[kind]) ? (settings[kind] as unknown[]) : [];
				settings[kind] = [...entries, resourceDir];
			}
		}
		return settings;
	}

	// Selection plans: the trusted project's settings merge into the base
	// per Pi's merge rules (project wins, nested objects merge), then the
	// filtering encoding replaces the managed keys on top. With
	// defaultProjectTrust: "never", Pi itself never reads project settings.
	//
	// The project's `packages` key is stripped: project packages install
	// under the project's .pi/npm and are unreferenceable in generated
	// global-scope settings — merging the key would make Pi install them
	// into the (symlinked) global npm root as a launch side effect.
	let base = { ...userSettings };
	if (options.projectSettings !== undefined) {
		const { packages: _stripped, ...mergeable } = options.projectSettings;
		base = deepMergeSettings(base, mergeable);
	}
	return buildSelectionSettings(plan, base, agentDir, options.discovery ?? { skills: [], packages: [] }, runtimeDir);
}

/** Resolved name sets, carried in the launch plan for glob-delta reporting. */
export interface ResolvedNames {
	skills: string[];
	extensions: string[];
	tools?: string[];
	mcps?: string[];
}

/** Writes settings.json + pi-profile.json into an existing runtime dir and
 *  transitions the trust.json link to the plan's filter mode: linked for
 *  `default` (native trust behavior), absent for named profiles (a stored
 *  trust decision would beat the generated `defaultProjectTrust: "never"`
 *  inside Pi and re-enable unfiltered project auto-discovery). */
export async function writeRuntimeFiles(
	runtimeDir: string,
	plan: ActivationPlan,
	options: RuntimeFileOptions,
): Promise<void> {
	const settings = await computeSettings(plan, options, runtimeDir);
	await writeFile(path.join(runtimeDir, "settings.json"), `${JSON.stringify(settings, null, 2)}\n`);

	// The launch plan feeds the in-pi extension: instructions injection,
	// tool/model re-application after reload, MCP coordination, switching.
	// agentDir is the REAL agent dir — the extension needs it for trust
	// checks, state files, and catalog/registry reads (its own
	// PI_CODING_AGENT_DIR points at this runtime dir).
	await writeFile(
		path.join(runtimeDir, "pi-profile.json"),
		`${JSON.stringify(
			{
				profile: plan.profile,
				source: plan.source,
				agentDir: options.agentDir,
				...(plan.instructions !== undefined ? { instructions: plan.instructions } : {}),
				...(plan.model !== undefined ? { model: plan.model } : {}),
				...(plan.tools !== undefined ? { tools: plan.tools } : {}),
				...(plan.toolReferences !== undefined ? { toolReferences: plan.toolReferences } : {}),
				...(plan.mcps !== undefined ? { mcps: plan.mcps } : {}),
				// The resolved sets feed /profile status (absolute paths) and the
				// glob-delta diff against the previous activation.
				resolved: {
					skills: plan.skills.map((skill) => ({ name: skill.name, filePath: skill.filePath })),
					extensions: plan.extensions,
				},
				// Zero-match glob references (ADR-0006) — surfaced by /profile status
				// so a typo'd glob is visible instead of silently selecting nothing.
				...(plan.unmatched !== undefined ? { unmatched: plan.unmatched } : {}),
				...options.planExtras,
			},
			null,
			2,
		)}\n`,
	);

	const trustLink = path.join(runtimeDir, "trust.json");
	const trustTarget = path.join(options.agentDir, "trust.json");
	if (plan.filter === "none") {
		if ((await exists(trustTarget)) && !(await exists(trustLink))) {
			await symlink(trustTarget, trustLink);
		}
	} else if (await exists(trustLink)) {
		await rm(trustLink);
	}

	// MCP Servers generation (Ticket 04)
	const mcpTarget = path.join(options.agentDir, "mcp.json");
	const mcpInstancePath = path.join(runtimeDir, "mcp.json");
	if (plan.mcps === undefined) {
		// No restrictions, symlink
		if (await exists(mcpTarget)) {
			try { await rm(mcpInstancePath); } catch {}
			await symlink(mcpTarget, mcpInstancePath);
		}
	} else {
		// Filter MCP servers
		try { await rm(mcpInstancePath); } catch {}
		if (await exists(mcpTarget)) {
			try {
				const mcpContent = await readFile(mcpTarget, "utf8");
				let mcpParsed = JSON.parse(mcpContent);
				if (isRecord(mcpParsed) && isRecord(mcpParsed.mcpServers)) {
					const filteredServers: Record<string, unknown> = {};
					for (const serverName of plan.mcps) {
						if (mcpParsed.mcpServers[serverName] !== undefined) {
							filteredServers[serverName] = mcpParsed.mcpServers[serverName];
						}
					}
					mcpParsed.mcpServers = filteredServers;
					await writeFile(mcpInstancePath, JSON.stringify(mcpParsed, null, 2));
				} else {
					// Malformed or empty, write empty
					await writeFile(mcpInstancePath, JSON.stringify({ mcpServers: {} }, null, 2));
				}
			} catch {
				await writeFile(mcpInstancePath, JSON.stringify({ mcpServers: {} }, null, 2));
			}
		} else {
			await writeFile(mcpInstancePath, JSON.stringify({ mcpServers: {} }, null, 2));
		}
	}

	// Instructions generation (Ticket 04)
	const appendSystemPath = path.join(runtimeDir, "APPEND_SYSTEM.md");
	if (plan.instructions !== undefined && plan.instructions.trim() !== "") {
		await writeFile(appendSystemPath, plan.instructions);
	} else {
		try { await rm(appendSystemPath); } catch {}
	}

	// Full-fidelity symlink mirroring and dangling link cleanup (Ticket 02).
	await syncAgentSymlinks(options.agentDir, runtimeDir);
}

/**
 * Full-fidelity symlink mirroring of the user's real agentDir into runtimeDir (Ticket 02).
 * - Excludes profile-managed files.
 * - Mirrors both file and directory symlinks.
 * - Detects and cleans up dangling or obsolete symlinks in runtimeDir.
 * - Avoids recreating identical existing symlinks to minimize startup I/O.
 */
export async function syncAgentSymlinks(agentDir: string, runtimeDir: string): Promise<void> {
	if (!existsSync(agentDir)) return;
	if (path.resolve(agentDir) === path.resolve(runtimeDir)) return;

	// Ensure the real sessions directory exists so it is always mirrored
	await mkdir(path.join(agentDir, "sessions"), { recursive: true });

	// 1. Clean up dangling or obsolete symlinks in runtimeDir
	try {
		const runtimeEntries = await readdir(runtimeDir);
		for (const name of runtimeEntries) {
			if (MANAGED_INSTANCE_FILES.has(name)) continue;
			const linkPath = path.join(runtimeDir, name);
			const target = path.join(agentDir, name);
			try {
				const linkStat = await lstat(linkPath);
				if (linkStat.isSymbolicLink()) {
					if (!existsSync(target)) {
						await rm(linkPath, { recursive: true, force: true });
					}
				}
			} catch {
				// Best-effort cleanup
			}
		}
	} catch {}

	// 2. Mirror files and directories from agentDir to runtimeDir
	try {
		const entries = await readdir(agentDir);
		for (const name of entries) {
			if (MANAGED_INSTANCE_FILES.has(name)) continue;

			const target = path.join(agentDir, name);
			const linkPath = path.join(runtimeDir, name);

			try {
				const linkStat = await lstat(linkPath).catch(() => null);
				if (linkStat) {
					if (linkStat.isSymbolicLink()) {
						const currentTarget = await readlink(linkPath).catch(() => null);
						if (currentTarget === target) {
							continue;
						}
					}
					await rm(linkPath, { recursive: true, force: true });
				}

				const info = await stat(target);
				await symlink(target, linkPath, info.isDirectory() ? "dir" : "file");
			} catch {
				// Ignore broken source links or unreadable files
			}
		}
	} catch {}
}

export async function generateRuntimeDir(
	plan: ActivationPlan,
	options: GenerateOptions,
): Promise<GeneratedRuntime> {
	const { agentDir } = options;
	const runtimeDir = path.join(getInstancesRootDir(), plan.profile, "agent");
	await mkdir(runtimeDir, { recursive: true });

	await writeRuntimeFiles(runtimeDir, plan, options);

	const flags: string[] = [];

	return {
		runtimeDir,
		env: {
			PI_CODING_AGENT_DIR: runtimeDir,
		},
		flags,
	};
}
