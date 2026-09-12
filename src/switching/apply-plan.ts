/**
 * ApplyLaunchPlan: applies the launch plan inside a running Pi after every
 * session start (startup, reload, new/resume/fork) — the post-reload half of
 * switching (ticket 05).
 *
 * The freshly re-executed pi-profile extension calls this from its
 * `session_start` handler. It is dependency-injected against a narrow pi
 * surface so unit tests never need a real Pi.
 *
 * Steps:
 *   1. tools: re-expand the profile's raw tool references against Pi's LIVE
 *      tool registry (includes extension-provided tools the pre-spawn
 *      expansion cannot know) and setActiveTools. Literals that no tool
 *      provides are dropped with a warning — Pi silently ignores unknown
 *      names, so the warning is the only signal.
 *   2. model: setModel + setThinkingLevel when declared.
 *   3. mcp: probe the adapter and publish the runtime allowlist (ticket 04).
 *   4. persistence: when the plan is marked `persistSelection` and this is a
 *      reload, save the selection and the rollback anchor
 *      (activeProfile = lastVerifiedProfile = plan.profile) to the
 *      profile's scope state file. Launch-transient selections never write.
 *   5. change summary: a `switchedFrom` marker produces a one-shot summary
 *      for the next agent turn and is cleared from the plan file.
 *
 * Pi's reload re-executes extension modules, so no stale handler or command
 * context survives; this module is the only place post-reload state is
 * established.
 */

import { writeFile } from "node:fs/promises";
import path from "node:path";

import { isRecord, readJsonFile } from "../json-file.ts";
import {
	MCP_ALLOWLIST_EVENT,
	MCP_ALLOWLIST_VERSION,
	MissingMcpAdapterError,
	probeAdapterPresence,
} from "../mcp-coordination.ts";
import { RuntimeStateStore } from "../runtime-state-store.ts";
import { expandToolReferences } from "./tool-references.ts";

export interface LaunchPlanFile {
	profile: string;
	source: string;
	agentDir?: string;
	instructions?: string;
	model?: { provider: string; id: string; thinkingLevel?: string };
	tools?: string[];
	toolReferences?: string[];
	mcp?: string[];
	switchedFrom?: string;
	persistSelection?: boolean;
	clearOverlay?: boolean;
	resolved?: {
		skills: Array<{ name: string; filePath: string }>;
		extensions: Array<{ id: string; entry: string }>;
	};
	previousResolved?: {
		skills: string[];
		extensions: string[];
		tools?: string[];
		mcp?: string[];
	};
}

/** The narrow slice of ExtensionAPI/Context the application needs. */
export interface PlanApplicationSurface {
	getAllTools(): Array<{ name: string }>;
	setActiveTools(names: string[]): void;
	modelRegistry: { find(provider: string, id: string): unknown | undefined };
	setModel(model: unknown): Promise<boolean>;
	setThinkingLevel(level: unknown): void;
	events: { emit(channel: string, data: unknown): void };
	notify?(message: string, level: "info" | "warning" | "error"): void;
}

export interface ApplyResult {
	/** One-shot profile-change summary for the next agent turn, if any. */
	summary?: string;
	warnings: string[];
}

export async function readLaunchPlanFile(runtimeDir: string): Promise<LaunchPlanFile | undefined> {
	const result = await readJsonFile(path.join(runtimeDir, "pi-profile.json"));
	if (!result.ok || !isRecord(result.value) || typeof result.value.profile !== "string") {
		return undefined;
	}
	return result.value as unknown as LaunchPlanFile;
}

/** Applies the plan carried by the runtime dir's pi-profile.json. */
export async function applyLaunchPlan(input: {
	runtimeDir: string;
	cwd: string;
	/** The session_start reason ("startup" | "reload" | "new" | ...). */
	reason: string;
	surface: PlanApplicationSurface;
}): Promise<ApplyResult> {
	const { surface } = input;
	const plan = await readLaunchPlanFile(input.runtimeDir);
	if (plan === undefined) {
		return { warnings: [] };
	}
	const warnings: string[] = [];

	// --- tools ---
	if (plan.toolReferences !== undefined) {
		const liveNames = surface.getAllTools().map((tool) => tool.name);
		const { expanded, droppedLiterals } = expandToolReferences(plan.toolReferences, liveNames);
		if (droppedLiterals.length > 0) {
			warnings.push(
				`profile "${plan.profile}": tools ${droppedLiterals.map((name) => JSON.stringify(name)).join(", ")} match nothing in Pi's live registry`,
			);
		}
		surface.setActiveTools(expanded);
	}

	// --- model ---
	if (plan.model !== undefined) {
		const found = surface.modelRegistry.find(plan.model.provider, plan.model.id);
		if (found === undefined) {
			warnings.push(`profile "${plan.profile}": declared model ${plan.model.provider}/${plan.model.id} not found`);
		} else {
			const applied = await surface.setModel(found);
			if (!applied) {
				warnings.push(
					`profile "${plan.profile}": model ${plan.model.provider}/${plan.model.id} has no configured auth`,
				);
			}
		}
		if (plan.model.thinkingLevel !== undefined) {
			surface.setThinkingLevel(plan.model.thinkingLevel);
		}
	}

	// --- mcp coordination (ticket 04 contract) ---
	if (plan.mcp !== undefined && plan.mcp.length > 0) {
		if (!probeAdapterPresence(surface.events)) {
			const error = new MissingMcpAdapterError(plan.profile);
			surface.notify?.(error.message, "error");
			throw error;
		}
		surface.events.emit(MCP_ALLOWLIST_EVENT, {
			version: MCP_ALLOWLIST_VERSION,
			profile: plan.profile,
			servers: plan.mcp,
		});
	}

	// --- persistence + rollback anchor (post-reload only) ---
	if (plan.persistSelection === true && input.reason === "reload" && plan.agentDir !== undefined) {
		const stateDir = plan.source === "project" ? path.join(input.cwd, ".pi") : plan.agentDir;
		// Merge: the overlay belongs to customize/reset, not to this write.
		// A switch (clearOverlay) explicitly drops it.
		await new RuntimeStateStore(stateDir).update({
			activeProfile: plan.profile,
			lastVerifiedProfile: plan.profile,
			...(plan.clearOverlay === true ? { overlay: undefined } : {}),
		});
	}

	// --- one-shot change summary ---
	let summary: string | undefined;
	if (typeof plan.switchedFrom === "string" && plan.switchedFrom.length > 0) {
		summary = buildSwitchSummary(plan);
		surface.notify?.(summary, "info");
		await clearSwitchMarker(input.runtimeDir);
	}

	for (const warning of warnings) {
		surface.notify?.(warning, "warning");
	}
	return { summary, warnings };
}

function buildSwitchSummary(plan: LaunchPlanFile): string {
	const parts = [
		`profile switched: ${plan.switchedFrom} → ${plan.profile}`,
		plan.tools !== undefined ? `tools: [${plan.tools.join(", ")}]` : undefined,
		plan.mcp !== undefined && plan.mcp.length > 0 ? `mcp: [${plan.mcp.join(", ")}]` : undefined,
		plan.model !== undefined ? `model: ${plan.model.provider}/${plan.model.id}` : undefined,
	].filter((part): part is string => part !== undefined);
	return parts.join("; ");
}

/** Clears the one-shot marker so the summary fires exactly once, even
 *  across later reloads. */
async function clearSwitchMarker(runtimeDir: string): Promise<void> {
	const plan = await readLaunchPlanFile(runtimeDir);
	if (plan === undefined) return;
	delete plan.switchedFrom;
	await writeFile(path.join(runtimeDir, "pi-profile.json"), `${JSON.stringify(plan, null, 2)}\n`);
}
