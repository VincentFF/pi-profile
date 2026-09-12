/**
 * RuntimeStateStore: reads the global runtime state file
 * (`<agentDir>/pi-profile-state.json`).
 *
 * Ticket 02 is read-only: the launcher restores the saved active profile but
 * never writes state (the CLI's initial selection is transient by design).
 * Writes arrive with `/profile use` (ticket 05), project-scope state with
 * ticket 03, and overlays with ticket 06.
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

	constructor(agentDir: string) {
		this.#statePath = path.join(agentDir, "pi-profile-state.json");
	}

	async read(): Promise<RuntimeState> {
		const result = await readJsonFile(this.#statePath);
		if (!result.ok || !isRecord(result.value)) return {};
		return typeof result.value.activeProfile === "string" ? { activeProfile: result.value.activeProfile } : {};
	}
}
