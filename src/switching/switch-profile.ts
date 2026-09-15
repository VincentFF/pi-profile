/**
 * SwitchProfile: the in-session switching orchestrator (ticket 05).
 *
 * Runs inside Pi (the extension's `/profile use` / `/profile reload`), but
 * is written dependency-injected so unit tests never need a real Pi.
 *
 * Flow (`/profile use <name>`):
 *   1. wait for the agent to be idle (Pi's native `ctx.waitForIdle()`) — a
 *      running turn is never torn down
 *   2. snapshot the runtime dir's settings.json + pi-profile.json in memory
 *   3. re-resolve through the full launcher path (trust check, catalogs,
 *      discovery, registry, model/MCP validation) against the REAL agent
 *      dir — any failure here leaves the runtime untouched
 *   4. rewrite the runtime files in place (the running process's
 *      PI_CODING_AGENT_DIR cannot move) and mark the plan
 *      `persistSelection` so the post-reload extension instance saves the
 *      selection + rollback anchor
 *   5. `ctx.reload()` — Pi re-reads settings from disk, re-executes
 *      extensions, preserves the session
 *   6. VERIFY the reload ran: interactive Pi swallows reload refusals and
 *      errors (showError) instead of rejecting, so a resolved promise is
 *      not proof. A real reload invalidates this extension context — the
 *      `assertStale` probe throws iff that happened. A silent skip rolls
 *      back exactly like a rejection: restore the snapshot, reload again.
 *      The runtime never sits half-switched.
 *
 * `/profile reload` is the same path minus the `switchedFrom` marker (no
 * change summary) and preserving however the current profile became active
 * (transient launch selections stay transient).
 */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { resolveInitialProfile } from "../launcher/initial-profile.ts";
import { RuntimeStateStore, type RuntimeOverlay } from "../runtime-state-store.ts";
import { getGlobalStateDir } from "../workspace.ts";
import { writeRuntimeFiles } from "../settings-generator.ts";
import { readLaunchPlanFile } from "./apply-plan.ts";

export class SwitchError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SwitchError";
	}
}

export interface SwitchDeps {
	/** The active generated runtime dir (the running Pi's agent dir). */
	runtimeDir: string;
	/** The user's real agent dir (from the launch plan; trust, catalogs,
	 *  registries, and state all live there). */
	realAgentDir: string;
	/** The project working directory. */
	cwd: string;
	/** Pi's native idle wait (ctx.waitForIdle): resolves when the current
	 *  turn/compaction finishes. */
	waitForIdle(): Promise<void>;
	reload(): Promise<void>;
	/** Throws iff this extension context has been invalidated — proof the
	 *  reload actually re-executed extensions. Interactive Pi swallows reload
	 *  refusals/failures instead of rejecting, so without this probe a
	 *  skipped reload would be misreported as a successful switch. Optional
	 *  for tests; always provided by the extension. */
	assertStale?(): void;
}

export interface SwitchResult {
	profile: string;
	warnings: string[];
}

interface RuntimeSnapshot {
	settings?: string;
	plan?: string;
}

async function readIfExists(filePath: string): Promise<string | undefined> {
	try {
		return await readFile(filePath, "utf8");
	} catch (error) {
		// Absence is expected (first launch); anything else (permissions,
		// unreadable dir) must not silently disable rollback protection.
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

async function snapshotRuntimeFiles(runtimeDir: string): Promise<RuntimeSnapshot> {
	return {
		settings: await readIfExists(path.join(runtimeDir, "settings.json")),
		plan: await readIfExists(path.join(runtimeDir, "pi-profile.json")),
	};
}

async function restoreRuntimeFiles(runtimeDir: string, snapshot: RuntimeSnapshot): Promise<void> {
	if (snapshot.settings !== undefined) {
		await writeFile(path.join(runtimeDir, "settings.json"), snapshot.settings);
	}
	if (snapshot.plan !== undefined) {
		await writeFile(path.join(runtimeDir, "pi-profile.json"), snapshot.plan);
	}
}

/** Waits are delegated to Pi's native `ctx.waitForIdle()` (see SwitchDeps);
 *  no polling loop lives here. */

/** Reads the current plan file for `switchedFrom`/persistence. A missing or
 *  malformed plan means the session is not profile-managed: switching still
 *  works, with no prior name to report. */
async function readCurrentPlan(runtimeDir: string): Promise<{ profile?: string; persistSelection: boolean }> {
	const plan = await readLaunchPlanFile(runtimeDir);
	return { profile: plan?.profile, persistSelection: plan?.persistSelection === true };
}

export async function switchProfile(
	name: string | undefined,
	deps: SwitchDeps,
	options?: { reloadCurrent?: boolean; overlay?: RuntimeOverlay | null; clearOverlay?: boolean },
): Promise<SwitchResult> {
	const current = await readCurrentPlan(deps.runtimeDir);
	const target = options?.reloadCurrent === true ? (current.profile ?? name) : name;
	if (target === undefined) {
		throw new SwitchError("no active profile to reload");
	}

	// Overlay resolution: explicit `overlay` wins (customize), explicit
	// `null` suppresses (reset/switch), and a plain `/profile reload`
	// re-applies the stored overlay so runtime and state never diverge.
	let overlay = options?.overlay;
	if (overlay === undefined && options?.reloadCurrent === true && current.profile !== undefined) {
		const currentPlan = await readLaunchPlanFile(deps.runtimeDir);
		if (currentPlan?.agentDir !== undefined) {
			const stateDir = currentPlan.source === "project" ? path.join(deps.cwd, ".pi") : getGlobalStateDir(currentPlan.agentDir);
			overlay = (await new RuntimeStateStore(stateDir).read()).overlay ?? null;
		}
	}

	await deps.waitForIdle();

	// Snapshot before resolving so the rollback target always exists.
	const snapshot = await snapshotRuntimeFiles(deps.runtimeDir);

	// Full launcher resolution: trust gate, catalogs, discovery, dependency
	// closure, model + MCP validation. Failures here leave the runtime
	// untouched — nothing was written yet.
	const resolved = await resolveInitialProfile(
		target,
		{ agentDir: deps.realAgentDir, cwd: deps.cwd },
		{ overlay: overlay ?? undefined },
	);

	const isSwitch = !options?.reloadCurrent && target !== current.profile;
	// Carry the pre-switch resolved sets into the new plan for status deltas.
	const previousPlan = await readLaunchPlanFile(deps.runtimeDir);
	const previousResolved =
		previousPlan?.resolved !== undefined
			? {
					skills: previousPlan.resolved.skills.map((skill) => skill.name),
					extensions: previousPlan.resolved.extensions.map((entry) => entry.id),
					...(previousPlan.tools !== undefined ? { tools: previousPlan.tools } : {}),
					...(previousPlan.mcp !== undefined ? { mcp: previousPlan.mcp } : {}),
				}
			: undefined;
	await writeRuntimeFiles(deps.runtimeDir, resolved.plan, {
		agentDir: deps.realAgentDir,
		discovery: resolved.discovery,
		projectSettings: resolved.projectSettings,
		planExtras: {
			...(isSwitch && current.profile !== undefined ? { switchedFrom: current.profile } : {}),
			// `/profile use` persists; `/profile reload` keeps the current
			// profile's existing persistence (launch selections stay transient).
			persistSelection: options?.reloadCurrent === true ? current.persistSelection : true,
			// A switch discards the previous profile's overlay; the post-reload
			// instance drops it from the state file. Customize/reset manage the
			// overlay directly and never set this.
			...(options?.clearOverlay === true ? { clearOverlay: true } : {}),
			...(previousResolved !== undefined ? { previousResolved } : {}),
		},
	});

	const rollback = async (cause: string): Promise<never> => {
		// Restore the verified snapshot and reload again — the runtime must
		// never sit half-switched. State files were not written yet (the
		// post-reload extension instance owns them), so nothing else moved.
		await restoreRuntimeFiles(deps.runtimeDir, snapshot);
		try {
			await deps.reload();
		} catch {
			// The restore reload failing too is reported through the original error.
		}
		throw new SwitchError(
			`activation of profile "${target}" failed; restored the previous settings. Cause: ${cause}`,
		);
	};

	try {
		await deps.reload();
	} catch (error) {
		await rollback(error instanceof Error ? error.message : String(error));
	}

	// Interactive Pi reports reload refusals/failures via the UI instead of
	// rejecting — verify the reload actually re-executed extensions (which
	// invalidates this context) before calling the switch a success.
	if (deps.assertStale !== undefined) {
		let stale = false;
		try {
			deps.assertStale();
		} catch {
			stale = true;
		}
		if (!stale) {
			await rollback("Pi did not run the reload (refused or failed silently)");
		}
	}

	return { profile: resolved.plan.profile, warnings: resolved.warnings };
}
