/**
 * RuntimeStateStore: reads a `pi-profile-state.json` runtime state file.
 *
 * Constructed with the directory holding the state file: the real agent dir
 * for global state, the project's `.pi` dir for project state (read only
 * when the trust check passed). The launcher only reads — the initial CLI
 * selection is transient by design; writes arrive with `/profile use`
 * (ticket 05) and overlays with ticket 06.
 *
 * A missing or malformed state file is not an error — it simply means
 * "fall back to the default profile". Unexpected I/O errors propagate.
 */

import path from "node:path";

import { isRecord, readJsonFile } from "./json-file.ts";

export interface RuntimeState {
	activeProfile?: string;
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
		return typeof result.value.activeProfile === "string" ? { activeProfile: result.value.activeProfile } : {};
	}
}
