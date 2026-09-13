/**
 * RuntimeStateStore: reads and writes a `pi-profile-state.json` runtime
 * state file.
 *
 * Constructed with the directory holding the state file: the real agent dir
 * for global state, the project's `.pi` dir for project state (project
 * state is only touched when Pi reports the project trusted).
 *
 * `activeProfile` is the saved selection applied on the next start;
 * `overlay` is the temporary narrowing of the active profile, written by
 * `/profile customize` and deleted by `/profile reset`.
 *
 * A missing or malformed state file is not an error on read — it simply
 * means "fall back to the default profile". Unexpected I/O errors
 * propagate. A state file written by an older pi-profile-switch is read with its
 * retired fields (`lastVerifiedProfile`, `overlay.disabledExtensions`)
 * ignored; the next write drops them.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { isRecord, readJsonFile } from "./json-file.ts";
import type { ProfileSource } from "./profile-catalog.ts";

/** The state directory for one profile's source scope: the project's `.pi`
 *  dir for project profiles, the agent dir otherwise (built-in `default` is
 *  treated as global). */
export function stateDirFor(source: ProfileSource, dirs: { agentDir: string; cwd: string }): string {
	return source === "project" ? path.join(dirs.cwd, ".pi") : dirs.agentDir;
}

export interface RuntimeState {
	activeProfile?: string;
	overlay?: RuntimeOverlay;
	/** Patch-only marker: clears `activeProfile` from the store it is sent
	 *  to, and to that store alone. A profile switch sends it to the OTHER
	 *  scope's store, so a stale project selection cannot shadow the new
	 *  global choice on the next startup. Never stored, never read back. */
	otherActiveProfile?: undefined;
}

export interface RuntimeOverlay {
	disabledSkills?: string[];
	disabledMcp?: string[];
	/** Replaces the profile's tool references when set. */
	tools?: string[];
}

/** True when an overlay actually narrows the active profile. An overlay whose
 *  fields were all removed again (`/profile customize enable …`) is not a
 *  difference from the catalog, and `parseOverlay` drops an empty overlay on
 *  read. A `tools: []` override is a difference: it selects no tools. */
export function overlayNarrows(overlay: RuntimeOverlay | undefined): boolean {
	if (overlay === undefined) return false;
	return (
		(overlay.disabledSkills?.length ?? 0) > 0 ||
		(overlay.disabledMcp?.length ?? 0) > 0 ||
		overlay.tools !== undefined
	);
}

function parseOverlay(value: unknown): RuntimeOverlay | undefined {
	if (!isRecord(value)) return undefined;
	const overlay: RuntimeOverlay = {};
	for (const key of ["disabledSkills", "disabledMcp", "tools"] as const) {
		const list = value[key];
		if (Array.isArray(list) && list.every((entry) => typeof entry === "string")) {
			overlay[key] = list;
		}
	}
	return Object.keys(overlay).length > 0 ? overlay : undefined;
}

export class RuntimeStateStore {
	readonly #statePath: string;

	/** @param stateDir Directory holding `pi-profile-state.json` (agent dir or
	 *  project `.pi` dir). */
	constructor(stateDir: string) {
		this.#statePath = path.join(stateDir, "pi-profile-state.json");
	}

	async read(): Promise<RuntimeState> {
		const result = await readJsonFile(this.#statePath);
		if (!result.ok || !isRecord(result.value)) return {};
		const state: RuntimeState = {};
		if (typeof result.value.activeProfile === "string") {
			state.activeProfile = result.value.activeProfile;
		}
		const overlay = parseOverlay(result.value.overlay);
		if (overlay !== undefined) {
			state.overlay = overlay;
		}
		return state;
	}

	async write(state: RuntimeState): Promise<void> {
		await mkdir(path.dirname(this.#statePath), { recursive: true });
		const document: RuntimeState = {};
		if (state.activeProfile !== undefined) document.activeProfile = state.activeProfile;
		if (state.overlay !== undefined) document.overlay = state.overlay;
		await writeFile(this.#statePath, `${JSON.stringify(document, null, 2)}\n`);
	}

	/** Read-modify-write merge. A field set to `undefined` is deleted; absent
	 *  fields keep their stored value. Used by the switch/customize paths so
	 *  one concern (selection, overlay) never clobbers another. */
	async update(patch: Partial<RuntimeState>): Promise<RuntimeState> {
		const current = await this.read();
		const next: RuntimeState = { ...current };
		if ("activeProfile" in patch) {
			if (patch.activeProfile === undefined) delete next.activeProfile;
			else next.activeProfile = patch.activeProfile;
		}
		if ("overlay" in patch) {
			if (patch.overlay === undefined) delete next.overlay;
			else next.overlay = patch.overlay;
		}
		if ("otherActiveProfile" in patch) delete next.activeProfile;
		await this.write(next);
		return next;
	}
}
