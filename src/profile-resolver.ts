/**
 * ProfileResolver: turns one profile definition plus an optional runtime
 * overlay into an immutable selection, resolved against Pi's LIVE resources.
 *
 * ADR-0007 semantics:
 * - `skills` resolves to a visibility filter (see skill-selection.ts), not
 *   to loaded resources: every skill stays loaded and user-invocable.
 * - `mcps` resolves to a runtime server allowlist; a declared MCP intent that
 *   cannot be satisfied (adapter absent, literal server unknown) fails the
 *   activation before anything is applied.
 * - `tools` resolves to an active tool set; literals the live registry does
 *   not provide yet become `pendingTools` and are retried, because MCP and
 *   extension tools register after session start.
 * - `model` and `instructions` pass through unchanged; applying them is the
 *   caller's job.
 *
 * The resolver is a pure function: same inputs, same selection, no I/O.
 */

import { isGlob, matchesReference, suggestNames } from "./name-matching.ts";
import type { ProfileModel, ProfileSource, ResolvedProfile } from "./profile-catalog.ts";
import type { RuntimeOverlay } from "./runtime-state-store.ts";

/** The live resource view a resolution runs against. */
export interface LiveResources {
	/** Pi's loaded skills. `undefined` when the caller cannot read them yet:
	 *  Pi exposes the list on command contexts and on the `before_agent_start`
	 *  event, not in `session_start`'s event context. An unknown set leaves the
	 *  visibility filter intact and reports nothing (see `skillWarnings`). */
	skills?: Array<{ name: string; filePath: string }>;
	toolNames: string[];
	/** MCP adapter state: presence plus discovered server names. */
	mcp: { adapterPresent: boolean; servers: string[] };
}

/** The skill references of a visibility filter: literals/globs, or `"all"`
 *  when the profile declares none and only the overlay narrows (nothing is
 *  hidden by omission). An empty array means "no skill is visible". */
export type SkillRefs = string[] | "all";

/** The skill visibility filter handed to the prompt builder each turn. */
export interface SkillsFilter {
	refs: SkillRefs;
	/** Skill name references removed from the visible set. */
	disabled: string[];
}

/** A literal reference no live resource provides, with near-name hints. */
export interface UnresolvedRef {
	reference: string;
	suggestions: string[];
}

export interface SelectionWarnings {
	skillsUnresolved: UnresolvedRef[];
	skillsUnmatched: string[];
	mcpUnmatched: string[];
	toolsUnmatched: string[];
}

export interface ResolvedSelection {
	name: string;
	source: ProfileSource;
	instructions?: string;
	model?: ProfileModel;
	/** Undefined means no visibility filtering (the whole loaded set). */
	skills?: SkillsFilter;
	/** Runtime MCP allowlist; undefined means publish nothing. */
	mcp?: string[];
	/** Active tool names; undefined means leave Pi's active set untouched. */
	tools?: string[];
	/** Tool literals the live registry does not provide yet. */
	pendingTools: string[];
	warnings: SelectionWarnings;
}

export class SelectionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SelectionError";
	}
}

/** Existence warnings for skill references against one live skill set.
 *  `undefined` means "not known yet" — Pi's skill list is only readable from
 *  a command context or from the `before_agent_start` event, so a startup
 *  activation reports nothing instead of every reference as unloaded. The
 *  same function re-checks the references on the first turn, when the list
 *  (including skills contributed through `resources_discover`) is complete. */
export function skillWarnings(
	refs: readonly string[],
	live: LiveResources["skills"],
): Pick<SelectionWarnings, "skillsUnresolved" | "skillsUnmatched"> {
	const warning: Pick<SelectionWarnings, "skillsUnresolved" | "skillsUnmatched"> = {
		skillsUnresolved: [],
		skillsUnmatched: [],
	};
	if (live === undefined) return warning;
	for (const ref of refs) {
		const hits = live.filter((skill) => matchesReference(ref, skill.name));
		if (hits.length === 0) {
			if (isGlob(ref)) warning.skillsUnmatched.push(ref);
			else warning.skillsUnresolved.push({ reference: ref, suggestions: suggestNames(ref, live.map((s) => s.name)) });
		}
	}
	return warning;
}

function resolveSkills(
	declared: string[] | undefined,
	disabled: string[],
	live: LiveResources["skills"],
): { filter?: SkillsFilter; warning: Pick<SelectionWarnings, "skillsUnresolved" | "skillsUnmatched"> } {
	if (declared === undefined) {
		// The profile declares nothing; an overlay may still hide skills.
		return {
			...(disabled.length > 0 ? { filter: { refs: "all" as const, disabled } } : {}),
			warning: skillWarnings([], live),
		};
	}
	return { filter: { refs: declared, disabled }, warning: skillWarnings(declared, live) };
}

function resolveMcp(
	declared: string[] | undefined,
	disabled: string[],
	live: LiveResources["mcp"],
	profileName: string,
): { servers?: string[]; warning: Pick<SelectionWarnings, "mcpUnmatched"> } {
	const warning = { mcpUnmatched: [] as string[] };
	if (declared === undefined) {
		// No declared intent: only an overlay narrowing publishes an allowlist.
		if (disabled.length === 0 || !live.adapterPresent) return { warning };
		return { servers: live.servers.filter((server) => !disabled.includes(server)), warning };
	}
	if (!live.adapterPresent) {
		throw new SelectionError(
			`profile "${profileName}" declares MCP servers but pi-mcp-adapter is not active in this session — ` +
				`install the adapter or remove the "mcps" declaration`,
		);
	}
	const selected: string[] = [];
	const missing: string[] = [];
	for (const ref of declared) {
		const hits = live.servers.filter((server) => matchesReference(ref, server));
		if (hits.length > 0) {
			selected.push(...hits);
			continue;
		}
		if (isGlob(ref)) warning.mcpUnmatched.push(ref);
		else missing.push(ref);
	}
	if (missing.length > 0) {
		throw new SelectionError(
			`profile "${profileName}": unknown MCP server ${missing.map((name) => JSON.stringify(name)).join(", ")} — ` +
				`adapter discovered: [${live.servers.join(", ")}]`,
		);
	}
	const servers = [...new Set(selected)].filter((server) => !disabled.includes(server));
	return { servers, warning };
}

function resolveTools(
	refs: string[] | undefined,
	live: LiveResources["toolNames"],
): {
	tools?: string[];
	pendingTools: string[];
	warning: Pick<SelectionWarnings, "toolsUnmatched">;
} {
	const warning = { toolsUnmatched: [] as string[] };
	if (refs === undefined) return { pendingTools: [], warning };
	const selected: string[] = [];
	const pending: string[] = [];
	for (const ref of refs) {
		const hits = live.filter((name) => matchesReference(ref, name));
		if (hits.length > 0) {
			selected.push(...hits);
			continue;
		}
		if (isGlob(ref)) warning.toolsUnmatched.push(ref);
		else pending.push(ref);
	}
	return { tools: [...new Set([...selected, ...pending])], pendingTools: [...new Set(pending)], warning };
}

/** Resolves one profile (plus overlay) against the live resources. Throws
 *  SelectionError when the profile's declared MCP intent cannot be
 *  satisfied; the caller applies nothing in that case.
 *
 *  `suppressTools` drops the profile's tool selection entirely, so a
 *  CLI-declared `--tools`/`--exclude-tools` keeps owning the active set
 *  (the preference table in docs/product/prd.md). */
export function resolveSelection(input: {
	profile: ResolvedProfile;
	overlay?: RuntimeOverlay;
	live: LiveResources;
	suppressTools?: boolean;
}): ResolvedSelection {
	const { profile, overlay, live } = input;
	const definition = profile.definition;

	const skills = resolveSkills(definition.skills, overlay?.disabledSkills ?? [], live.skills);
	const mcp = resolveMcp(definition.mcps, overlay?.disabledMcp ?? [], live.mcp, profile.name);
	const tools = input.suppressTools === true
		? { pendingTools: [], warning: { toolsUnmatched: [] } }
		: resolveTools(overlay?.tools ?? definition.tools, live.toolNames);

	const selection: ResolvedSelection = {
		name: profile.name,
		source: profile.source,
		pendingTools: tools.pendingTools,
		warnings: {
			...skills.warning,
			...mcp.warning,
			...tools.warning,
		},
	};
	if (definition.instructions !== undefined && definition.instructions.length > 0) {
		selection.instructions = definition.instructions;
	}
	if (definition.model !== undefined) {
		selection.model = definition.model;
	}
	if (skills.filter !== undefined) {
		selection.skills = skills.filter;
	}
	if (mcp.servers !== undefined) {
		selection.mcp = mcp.servers;
	}
	if (tools.tools !== undefined) {
		selection.tools = tools.tools;
	}
	return selection;
}

/** User-facing lines for one set of skill warnings. Shared by the startup
 *  report and the first-turn re-check, so both read identically. */
export function formatSkillWarnings(
	profile: string,
	warning: Pick<SelectionWarnings, "skillsUnresolved" | "skillsUnmatched">,
): string[] {
	const lines: string[] = [];
	for (const unresolved of warning.skillsUnresolved) {
		const hint =
			unresolved.suggestions.length > 0
				? ` — did you mean: ${unresolved.suggestions.map((name) => JSON.stringify(name)).join(", ")}?`
				: "";
		lines.push(
			`profile "${profile}": skill ${JSON.stringify(unresolved.reference)} is not loaded in this session${hint}`,
		);
	}
	if (warning.skillsUnmatched.length > 0) {
		lines.push(
			`profile "${profile}": skill glob(s) ${warning.skillsUnmatched.map((ref) => JSON.stringify(ref)).join(", ")} matched nothing`,
		);
	}
	return lines;
}

/** User-facing warning lines for one resolved selection. */
export function formatSelectionWarnings(selection: ResolvedSelection): string[] {
	const lines: string[] = formatSkillWarnings(selection.name, selection.warnings);
	if (selection.warnings.mcpUnmatched.length > 0) {
		lines.push(
			`profile "${selection.name}": MCP glob(s) ${selection.warnings.mcpUnmatched.map((ref) => JSON.stringify(ref)).join(", ")} matched nothing`,
		);
	}
	if (selection.warnings.toolsUnmatched.length > 0) {
		lines.push(
			`profile "${selection.name}": tool glob(s) ${selection.warnings.toolsUnmatched.map((ref) => JSON.stringify(ref)).join(", ")} matched nothing`,
		);
	}
	if (selection.pendingTools.length > 0) {
		lines.push(
			`profile "${selection.name}": tool(s) ${selection.pendingTools.map((name) => JSON.stringify(name)).join(", ")} are not registered yet — applied when they appear`,
		);
	}
	return lines;
}
