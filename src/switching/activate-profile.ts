/**
 * SwitchProfile: the in-session activation orchestrator (ADR-0007).
 *
 * There is no reload and no generated-settings rewrite. Activating a profile
 * means: resolve it against Pi's live resources, apply the runtime parts
 * (model, tools, MCP allowlist), and remember the choice. Skills and
 * instructions need no action here — they are applied by the next
 * `before_agent_start` from the returned selection.
 *
 * Flow:
 *   1. load the catalog (project entries only when Pi reports the project
 *      trusted) and resolve the name — unknown names fail with candidates
 *   2. resolve the selection against the live resources; a declared MCP
 *      intent that cannot be satisfied fails here
 *   3. validate the model preset (exists, has auth) — still nothing applied
 *   4. persist the choice to the target profile's scope state file
 *   5. apply model/thinking/tools/MCP; a failure reports loudly
 *
 * Startup activation passes `persist: false` (the flag selection must not
 * overwrite the saved one) and `overlay: null` (a stored overlay never
 * outlives its runtime).
 */

import { ProfileCatalog } from "../profile-catalog.ts";
import { decidePreset, type SessionChoices } from "../model-selection.ts";
import { resolveSelection, type LiveResources, type ResolvedSelection } from "../profile-resolver.ts";
import type { ExplicitDeclarations } from "../startup-selection.ts";
import { RuntimeStateStore, stateDirFor, type RuntimeOverlay } from "../runtime-state-store.ts";
import { applySelection, validateSelection, type ApplySurface } from "./apply-profile.ts";

export class ActivationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ActivationError";
	}
}

export interface ActivationDeps {
	/** The user's real agent dir (e.g. ~/.pi/agent). */
	agentDir: string;
	/** The project working directory. */
	cwd: string;
	/** Pi's trust decision for `cwd` (`ctx.isProjectTrusted()`). */
	projectTrusted: boolean;
	/** The live resource view loaded by the caller. */
	live: LiveResources;
	/** The narrow Pi surface the selection is applied to. */
	surface: ApplySurface;
	/** Inputs for the model-preset precedence decision (decided after the
	 *  profile resolves, since it depends on the declared model). */
	presetInputs: { explicit: ExplicitDeclarations; session: SessionChoices; force: boolean };
}

export interface ActivationResult {
	selection: ResolvedSelection;
	/** The overlay this activation applied; absent when the runtime runs the
	 *  profile exactly as it is declared. Callers surface it (the footer badge)
	 *  instead of re-reading the state file. */
	overlay?: RuntimeOverlay;
}

/** Resolves a profile against the live resources without applying it.
 *  Throws ActivationError for unknown names and SelectionError for declared
 *  MCP intents that cannot be satisfied. A CLI-declared
 *  `--tools`/`--exclude-tools` suppresses the profile's tool selection
 *  unless the user made an explicit `/profile use` choice. */
export async function resolveProfileSelection(
	name: string,
	deps: Pick<ActivationDeps, "agentDir" | "cwd" | "projectTrusted" | "live" | "presetInputs">,
	overlay?: RuntimeOverlay,
): Promise<ResolvedSelection> {
	const catalog = await ProfileCatalog.load(deps.agentDir, {
		projectDir: deps.projectTrusted ? deps.cwd : undefined,
	});
	const profile = catalog.resolve(name);
	if (profile === undefined) {
		throw new ActivationError(
			`unknown profile ${JSON.stringify(name)} — available: [${catalog.list().map((entry) => entry.name).join(", ")}]`,
		);
	}
	const suppressTools = !deps.presetInputs.force && deps.presetInputs.explicit.tools;
	return resolveSelection({ profile, overlay, live: deps.live, suppressTools });
}

/** Activates a profile: resolve, validate, optionally persist, apply. */
export async function activateProfile(
	name: string,
	deps: ActivationDeps,
	options?: { overlay?: RuntimeOverlay | null; persist?: boolean },
): Promise<ActivationResult> {
	const overlay = options?.overlay ?? undefined;
	const selection = await resolveProfileSelection(name, deps, overlay);
	const preset = decidePreset({ model: selection.model, ...deps.presetInputs });

	// Validate before touching anything: the model preset is the only
	// fallible runtime step.
	const validationError = validateSelection(selection, deps.surface, preset);
	if (validationError !== undefined) {
		throw new ActivationError(validationError);
	}

	if (options?.persist !== false) {
		await new RuntimeStateStore(stateDirFor(selection.source, deps)).update({
			activeProfile: selection.name,
			overlay: overlay ?? undefined,
		});
	}

	const result = await applySelection({ selection, surface: deps.surface, preset });
	if (!result.applied) {
		throw new ActivationError(result.error ?? `profile "${name}" could not be applied`);
	}

	return { selection, ...(overlay === undefined ? {} : { overlay }) };
}
