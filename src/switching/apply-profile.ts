/**
 * ApplyProfile: applies a resolved selection to the running Pi.
 *
 * Replaces the launch-plan application of the host architecture: there is no
 * plan file and no reload. Application is ordered so that the only
 * fallible step — the model preset — runs first; a failure leaves the
 * runtime untouched and the caller keeps the previous state.
 *
 * Steps:
 *   1. validate: the declared model exists and has configured auth.
 *   2. model: `setModel` + `setThinkingLevel` (when the preset applies).
 *   3. tools: `setActiveTools` with the resolved active set. Literals the
 *      live registry does not provide yet stay in `pendingTools` and are
 *      retried by the caller each turn (MCP and extension tools register
 *      after session start).
 *   4. mcp: publish the runtime server allowlist to pi-mcp-adapter.
 *
 * Dependency-injected against a narrow surface so unit tests never need a
 * real Pi.
 */

import {
	MCP_ALLOWLIST_EVENT,
	MCP_ALLOWLIST_VERSION,
} from "../mcp-coordination.ts";
import type { PresetDecisions } from "../model-selection.ts";
import type { ResolvedSelection } from "../profile-resolver.ts";

/** The narrow slice of ExtensionAPI/Context the application needs. */
export interface ApplySurface {
	getAllTools(): Array<{ name: string }>;
	setActiveTools(names: string[]): void;
	modelRegistry: {
		find(provider: string, id: string): unknown | undefined;
		hasConfiguredAuth(model: unknown): boolean;
	};
	setModel(model: unknown): Promise<boolean>;
	setThinkingLevel(level: string): void;
	events: { emit(channel: string, data: unknown): void };
}

export interface ApplyResult {
	applied: boolean;
	/** Present when nothing was applied. */
	error?: string;
	warnings: string[];
	/** Tool literals still missing from the live registry. */
	pendingTools: string[];
}

/** Checks everything that can be checked before mutating the runtime. */
export function validateSelection(
	selection: ResolvedSelection,
	surface: ApplySurface,
	preset: PresetDecisions,
): string | undefined {
	if (selection.model === undefined || !preset.model) return undefined;
	const model = surface.modelRegistry.find(selection.model.provider, selection.model.id);
	if (model === undefined) {
		return `profile "${selection.name}": declared model ${selection.model.provider}/${selection.model.id} not found`;
	}
	if (!surface.modelRegistry.hasConfiguredAuth(model)) {
		return `profile "${selection.name}": model ${selection.model.provider}/${selection.model.id} has no configured auth`;
	}
	return undefined;
}

/** Applies the selection. Validation runs first; on failure nothing is
 *  applied and the runtime keeps its previous state. */
export async function applySelection(input: {
	selection: ResolvedSelection;
	surface: ApplySurface;
	preset: PresetDecisions;
}): Promise<ApplyResult> {
	const { selection, surface, preset } = input;
	const error = validateSelection(selection, surface, preset);
	if (error !== undefined) {
		return { applied: false, error, warnings: [], pendingTools: [] };
	}

	if (selection.model !== undefined && preset.model) {
		const model = surface.modelRegistry.find(selection.model.provider, selection.model.id);
		const applied = await surface.setModel(model);
		if (!applied) {
			return {
				applied: false,
				error: `profile "${selection.name}": model ${selection.model.provider}/${selection.model.id} could not be activated`,
				warnings: [],
				pendingTools: [],
			};
		}
		if (selection.model.thinkingLevel !== undefined && preset.thinking) {
			surface.setThinkingLevel(selection.model.thinkingLevel);
		}
	}

	if (selection.tools !== undefined) {
		surface.setActiveTools(selection.tools);
	}

	if (selection.mcp !== undefined) {
		surface.events.emit(MCP_ALLOWLIST_EVENT, {
			version: MCP_ALLOWLIST_VERSION,
			profile: selection.name,
			servers: selection.mcp,
		});
	}

	return { applied: true, warnings: [], pendingTools: selection.pendingTools };
}

/** Retries pending tool literals against the live registry. Once every
 *  literal resolves the caller stops retrying, so a user's later native tool
 *  toggle is never clobbered. */
export function retryPendingTools(input: {
	selection: ResolvedSelection;
	surface: ApplySurface;
}): { pendingTools: string[]; active?: string[]; applied: boolean } {
	const { selection, surface } = input;
	if (selection.pendingTools.length === 0) {
		return { pendingTools: [], applied: false };
	}
	const live = new Set(surface.getAllTools().map((tool) => tool.name));
	const resolved = selection.pendingTools.filter((name) => live.has(name));
	if (resolved.length === 0) {
		return { pendingTools: selection.pendingTools, applied: false };
	}
	const active = [...new Set([...(selection.tools ?? []), ...resolved])];
	surface.setActiveTools(active);
	return { pendingTools: selection.pendingTools.filter((name) => !live.has(name)), active, applied: true };
}
