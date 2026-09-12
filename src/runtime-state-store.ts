/**
 * RuntimeStateStore: reads and writes a `pi-profile-state.json` runtime
 * state file.
 *
 * Constructed with the directory holding the state file: the real agent dir
 * for global state, the project's `.pi` dir for project state (project
 * state is only touched when the trust check passed). The launcher only
 * reads — the initial CLI selection is transient by design; `/profile use`
 * (ticket 05) writes both the selection and the rollback anchor.
 *
 * `activeProfile` is the saved selection restored on launch;
 * `lastVerifiedProfile` is the rollback anchor: the last profile whose
 * activation completed successfully. They differ only between a failed
 * activation and its rollback.
 *
 * A missing or malformed state file is not an error on read — it simply
 * means "fall back to the default profile". Unexpected I/O errors
 * propagate. Writes replace the file wholesale (both fields are always
 * written together by the switch path).
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { isRecord, readJsonFile } from "./json-file.ts";

export interface RuntimeState {
	activeProfile?: string;
	lastVerifiedProfile?: string;
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
		if (typeof result.value.lastVerifiedProfile === "string") {
			state.lastVerifiedProfile = result.value.lastVerifiedProfile;
		}
		return state;
	}

	async write(state: RuntimeState): Promise<void> {
		await mkdir(path.dirname(this.#statePath), { recursive: true });
		await writeFile(this.#statePath, `${JSON.stringify(state, null, 2)}\n`);
	}
}
