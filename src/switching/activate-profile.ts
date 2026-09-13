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

/** Drops a stale saved selection from the scope that no longer owns it. A
 *  project state file left behind by a previous project profile shadows the
 *  new global choice on the next startup (project state wins), so the switch
 *  path clears it; the scope's overlay stays, because that belongs to the
 *  profile it was created for. */
async function clearOtherSelection(stateDir: string): Promise<void> {
	const store = new RuntimeStateStore(stateDir);
	if ((await store.read()).activeProfile !== undefined) {
		await store.update({ otherActiveProfile: undefined });
	}
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
		// Exactly one scope holds the saved selection: the project state file
		// for a project profile, the global one otherwise (including the
		// built-in `default`). A project profile is only reachable in a
		// trusted project, so an untrusted project is skipped exactly like
		// its catalog read — its state file stays untouched (ADR-0007).
		const ownDir = stateDirFor(selection.source, deps);
		const projectDir = stateDirFor("project", deps);
		const writable = selection.source !== "project" || deps.projectTrusted;
		if (writable) {
			await new RuntimeStateStore(ownDir).update({
				activeProfile: selection.name,
				overlay: overlay ?? undefined,
			});
			// The scope that owned the previous selection must let go of it,
			// or the next startup restores it: project state wins over global.
			// An untrusted project is never read or written here either.
			const otherDir = selection.source === "project" ? stateDirFor("global", deps) : projectDir;
			if (otherDir !== ownDir && (otherDir !== projectDir || deps.projectTrusted)) {
				await clearOtherSelection(otherDir);
			}
		}
	}

	const result = await applySelection({ selection, surface: deps.surface, preset });
	if (!result.applied) {
		throw new ActivationError(result.error ?? `profile "${name}" could not be applied`);
	}

	return { selection, ...(overlay === undefined ? {} : { overlay }) };
}
