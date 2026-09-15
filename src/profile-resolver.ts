/**
 * ProfileResolver: a pure function from profile + registries to an immutable
 * ActivationPlan.
 *
 * Rules:
 * - Glob references (`*`, `?`) expand against the full registry at every
 *   resolution; zero matches is fine (new matches join on the next start) and
 *   is reported in the plan's `unmatched` list so typos are visible.
 * - Literal references must exist; a missing literal fails activation.
 *   Extension references resolve through ResourceRegistry.select (ADR-0006):
 *   registry ID, installed package name/alias, loose-file stem, or an
 *   on-disk path — no pre-registration required.
 * - `alwaysOn` resources and the recursive `dependsOn` closure join every
 *   plan; cycles and missing entries fail loudly (via ResourceRegistry).
 * - Undeclared model/thinking/instructions never enter the plan, so Pi's
 *   current state stays untouched.
 * - MCP references (`mcp`) expand against the server names the launcher
 *   discovered from pi-mcp-adapter's pi-native config files: literal misses
 *   fail loudly; globs expand to zero or more matches (consistent with
 *   skills/extensions). Adapter presence is checked separately by the
 *   launcher/extension (ADR-0002).
 * - Tool globs expand against Pi's built-in tool names only: extension- and
 *   MCP-provided tool names are unknowable before spawn (extension code must
 *   not execute here), so literal tool names pass through unvalidated and
 *   glob matching for contributed tools happens when the extension applies
 *   the plan against Pi's actual registrations (tickets 05+).
 */

import { minimatch } from "minimatch";

import type { DiscoveredExtensions } from "./extension-discovery.ts";
import type { ProfileDefinition, ProfileModel, ProfileSource, ResolvedProfile } from "./profile-catalog.ts";
import type { RuntimeOverlay } from "./runtime-state-store.ts";
import type { SkillEntry } from "./skill-registry.ts";

export class ActivationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ActivationError";
	}
}

/** Pi's built-in tool names (pi 0.85.1 `allToolNames`; not exported by the
 *  SDK). The integration suite guards drift. Literal tool names pass through
 *  regardless — extension-provided tools are unknowable before spawn. */
export const BUILTIN_TOOL_NAMES = ["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"] as const;

const VALID_THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

/** Immutable, fully resolved activation set. */
export interface ActivationPlan {
	profile: string;
	source: ProfileSource;
	/** "none" exposes everything Pi can discover (the default profile). */
	filter: "none" | "selection";
	/** Selected skills with their resolved SKILL.md paths. Empty for default. */
	skills: SkillEntry[];
	/** Selected extensions. Empty for default. */
	extensions: Array<{ id: string; entry: string; origin?: "package" | "local" | "path" }>;
	/** Expanded tool allowlist; undefined when the profile declares no tools. */
	tools?: string[];
	/** The raw tool references (globs included) for extension-side expansion
	 *  against Pi's live tool registry, which includes extension-provided
	 *  tools the pre-spawn expansion cannot know. Set iff `tools` is set. */
	toolReferences?: string[];
	/** Declared model; undefined leaves Pi's current model untouched. */
	model?: ProfileModel;
	/** Declared instructions; appended to Pi's system prompt by the extension. */
	instructions?: string;
	/** Expanded MCP server allowlist for pi-mcp-adapter coordination;
	 *  undefined when the profile declares no `mcp` (no coordination). */
	mcp?: string[];
	/** Glob references (skills/extensions/MCP) that matched nothing this
	 *  resolution — surfaced as warnings so zero-match typos are never silent.
	 *  Tool globs are excluded: extension-contributed tools are unknowable
	 *  before spawn, so a pre-spawn zero-match proves nothing. */
	unmatched?: string[];
}

export interface ResolveInput {
	profile: ResolvedProfile;
	/** The full SkillRegistry result (not just selected skills). */
	skills: SkillEntry[];
	extensions: DiscoveredExtensions;
	/**
	 * Validates a declared model (exists and is authenticated) against the
	 * user's real model/auth state. Returns an error message or undefined.
	 * The launcher always provides this; a declared model without a validator
	 * fails activation rather than silently skipping the check.
	 */
	validateModel?: (model: ProfileModel) => Promise<string | undefined>;
	/**
	 * Server names discovered from pi-mcp-adapter's pi-native config files
	 * (see mcp-config.ts). Required when the profile declares `mcp`: without
	 * the discovered names a reference cannot be validated, so activation
	 * fails rather than passing references through unchecked.
	 */
	discoveredMcpServers?: string[];
	/**
	 * The runtime overlay (ticket 06): temporary narrowing applied on top of
	 * the profile definition at every resolution. Overlay references must
	 * name resources the profile actually resolves (typos fail loudly), and
	 * `alwaysOn` extensions and their dependency chains cannot be disabled.
	 */
	overlay?: RuntimeOverlay;
}

function isGlob(reference: string): boolean {
	return reference.includes("*") || reference.includes("?");
}

/** Expands one reference list against a named universe. Literal misses fail
 *  when `literalMustExist`; globs expand to zero or more matches, and a
 *  zero-match glob is reported through `onZeroMatch`. */
function expandReferences<T>(
	references: string[],
	universe: readonly T[],
	nameOf: (item: T) => string,
	kind: string,
	options?: { literalMustExist?: boolean; onZeroMatch?: (reference: string) => void },
): T[] {
	const selected = new Map<string, T>();
	for (const reference of references) {
		if (isGlob(reference)) {
			let matched = 0;
			for (const item of universe) {
				if (minimatch(nameOf(item), reference)) {
					selected.set(nameOf(item), item);
					matched += 1;
				}
			}
			if (matched === 0) options?.onZeroMatch?.(reference);
			continue;
		}
		const item = universe.find((candidate) => nameOf(candidate) === reference);
		if (item === undefined) {
			if (options?.literalMustExist === false) {
				// Pass-through (e.g. extension-provided tool names).
				selected.set(reference, reference as T);
				continue;
			}
			throw new ActivationError(`unknown ${kind}: "${reference}" does not match any discovered ${kind}`);
		}
		selected.set(reference, item);
	}
	return [...selected.values()];
}

/** The built-in default profile: everything Pi can discover, no filtering. */
export function defaultPlan(): ActivationPlan {
	return { profile: "default", source: "builtin", filter: "none", skills: [], extensions: [] };
}

export async function resolveProfile(input: ResolveInput): Promise<ActivationPlan> {
	const { profile, skills, extensions, overlay } = input;
	const definition: ProfileDefinition = profile.definition;
	const unmatched: string[] = [];

	let mcp: string[] | undefined;
	if (definition.mcp !== undefined && definition.mcp.length > 0) {
		if (input.discoveredMcpServers === undefined) {
			throw new ActivationError(
				`profile "${profile.name}" declares MCP servers but no adapter server discovery is available`,
			);
		}
		mcp = expandReferences(definition.mcp, input.discoveredMcpServers, (name) => name, "MCP server", {
			onZeroMatch: (reference) => unmatched.push(`mcp:${reference}`),
		});
	}

	let selectedSkills = expandReferences(definition.skills ?? [], skills, (skill) => skill.name, "skill", {
		onZeroMatch: (reference) => unmatched.push(`skill:${reference}`),
	});

	// Extension references resolve directly against discovered extensions.
	const selection = await extensions.select(definition.extensions ?? []);
	for (const reference of selection.unmatched) unmatched.push(`extension:${reference}`);
	let planExtensions: Array<{ id: string; entry: string; origin?: "package" | "local" | "path" }> = selection.entries.map(
		(entry) => ({
			id: entry.id,
			entry: entry.entry,
			...(entry.origin ? { origin: entry.origin } : {}),
		}),
	);

	// --- overlay narrowing (ticket 06) ---
	// Overlay references must name resources the profile actually resolves
	// (typos fail loudly). Overlays can disable any resolved extension.
	let toolReferences = definition.tools;
	if (overlay !== undefined) {
		if (overlay.disabledSkills !== undefined && overlay.disabledSkills.length > 0) {
			const active = new Set(selectedSkills.map((skill) => skill.name));
			for (const name of overlay.disabledSkills) {
				if (!active.has(name)) {
					throw new ActivationError(`profile "${profile.name}": overlay disables unknown skill "${name}"`);
				}
			}
			const disabled = new Set(overlay.disabledSkills);
			selectedSkills = selectedSkills.filter((skill) => !disabled.has(skill.name));
		}
		if (overlay.disabledExtensions !== undefined && overlay.disabledExtensions.length > 0) {
			const activeIds = new Set(planExtensions.map((entry) => entry.id));
			for (const id of overlay.disabledExtensions) {
				if (!activeIds.has(id)) {
					throw new ActivationError(`profile "${profile.name}": overlay disables unknown extension "${id}"`);
				}
			}
			const disabled = new Set(overlay.disabledExtensions);
			planExtensions = planExtensions.filter((entry) => !disabled.has(entry.id));
		}
		if (overlay.disabledMcp !== undefined && overlay.disabledMcp.length > 0) {
			const active = new Set(mcp ?? []);
			for (const name of overlay.disabledMcp) {
				if (!active.has(name)) {
					throw new ActivationError(`profile "${profile.name}": overlay disables unknown MCP server "${name}"`);
				}
			}
			const disabled = new Set(overlay.disabledMcp);
			mcp = (mcp ?? []).filter((name) => !disabled.has(name));
		}
		if (overlay.tools !== undefined) {
			toolReferences = overlay.tools;
		}
	}

	let tools: string[] | undefined;
	if (toolReferences !== undefined) {
		tools = expandReferences(toolReferences, BUILTIN_TOOL_NAMES, (name) => name, "tool", {
			literalMustExist: false,
		});
	}

	let model: ProfileModel | undefined;
	if (definition.model !== undefined) {
		const declared = definition.model;
		if (declared.thinkingLevel !== undefined && !VALID_THINKING_LEVELS.has(declared.thinkingLevel)) {
			throw new ActivationError(
				`profile "${profile.name}": invalid thinkingLevel ${JSON.stringify(declared.thinkingLevel)}`,
			);
		}
		if (input.validateModel === undefined) {
			throw new ActivationError(`profile "${profile.name}" declares a model but no model validator is available`);
		}
		const error = await input.validateModel(declared);
		if (error !== undefined) {
			throw new ActivationError(`profile "${profile.name}": model ${declared.provider}/${declared.id}: ${error}`);
		}
		model = declared;
	}

	return {
		profile: profile.name,
		source: profile.source,
		filter: "selection",
		skills: selectedSkills,
		extensions: planExtensions.map((entry) => ({ id: entry.id, entry: entry.entry })),
		...(tools !== undefined && toolReferences !== undefined ? { tools, toolReferences: [...toolReferences] } : {}),
		...(model !== undefined ? { model } : {}),
		...(definition.instructions !== undefined ? { instructions: definition.instructions } : {}),
		...(mcp !== undefined ? { mcp } : {}),
		...(unmatched.length > 0 ? { unmatched } : {}),
	};
}
