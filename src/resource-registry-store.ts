/**
 * ResourceRegistryStore: the WRITE side of the extension resource registry
 * (ticket 08), kept separate from the read-only ResourceRegistry.
 *
 * Invariants:
 * - Writes are whole-file overwrites (pretty-printed, schemaVersion
 *   envelope preserved). Per the ticket, wizard saves overwrite external
 *   concurrent edits instead of blocking on them — last write wins.
 * - Validation reuses the registry's own entry parser, so anything the
 *   store writes is guaranteed loadable by ResourceRegistry.load.
 * - Entries are `extension` kind only; MCP capabilities cannot be declared
 *   through the resource registry.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { isRecord, readJsonFile } from "./json-file.ts";
import { PROFILE_SCHEMA_VERSION } from "./profile-catalog.ts";
import { parseResourceEntry, RegistryError, type RawResourceEntry } from "./resource-registry.ts";

/** The serializable entry shape accepted by the wizard (kind is fixed).
 *  `entry` may be omitted when the ID matches a discovered extension — the
 *  discovered entry is inherited at load time (ADR-0006). */
export interface RegistryEntryInput {
	id: string;
	entry?: string;
	dependsOn?: string[];
	alwaysOn?: boolean;
}

export class ResourceRegistryStore {
	readonly #filePath: string;

	constructor(registryPath: string) {
		this.#filePath = registryPath;
	}

	/** Raw resources map: missing file → empty; malformed → RegistryError
	 *  (registry errors never pass silently, even on the write path). */
	async readEntries(): Promise<Map<string, RawResourceEntry>> {
		const result = await readJsonFile(this.#filePath);
		if (!result.ok) {
			if (result.reason === "missing") return new Map();
			throw new RegistryError(`invalid JSON in ${this.#filePath}`);
		}
		if (!isRecord(result.value)) {
			throw new RegistryError(`${this.#filePath}: registry must be an object`);
		}
		if (result.value.schemaVersion !== PROFILE_SCHEMA_VERSION) {
			throw new RegistryError(
				`${this.#filePath}: unsupported schemaVersion ${JSON.stringify(result.value.schemaVersion)} (expected ${PROFILE_SCHEMA_VERSION})`,
			);
		}
		if (!isRecord(result.value.resources)) {
			throw new RegistryError(`${this.#filePath}: "resources" must be an object mapping IDs to entries`);
		}
		// Reuse the registry's own parser: the store can never hold an entry
		// the reader would reject.
		const entries = new Map<string, RawResourceEntry>();
		for (const [id, raw] of Object.entries(result.value.resources)) {
			entries.set(id, parseResourceEntry(id, raw));
		}
		return entries;
	}

	/** Overwrites the file with the given entries (last write wins). */
	async writeEntries(entries: ReadonlyMap<string, RawResourceEntry>): Promise<void> {
		const resources: Record<string, unknown> = {};
		for (const [id, entry] of [...entries.entries()].sort(([a], [b]) => a.localeCompare(b))) {
			resources[id] = {
				kind: "extension",
				...(entry.entry !== undefined ? { entry: entry.entry } : {}),
				...(entry.dependsOn.length > 0 ? { dependsOn: entry.dependsOn } : {}),
				...(entry.alwaysOn ? { alwaysOn: true } : {}),
			};
		}
		await mkdir(path.dirname(this.#filePath), { recursive: true });
		await writeFile(
			this.#filePath,
			`${JSON.stringify({ schemaVersion: PROFILE_SCHEMA_VERSION, resources }, null, 2)}\n`,
		);
	}

	/** Validates + inserts or replaces one entry. */
	async upsert(input: RegistryEntryInput): Promise<void> {
		if (input.id.trim().length === 0) {
			throw new RegistryError(`resource id must be non-empty`);
		}
		if (input.entry !== undefined && input.entry.trim().length === 0) {
			throw new RegistryError(`resource "${input.id}": "entry" must be a non-empty string when present`);
		}
		if (input.dependsOn?.some((dep) => dep.trim().length === 0)) {
			throw new RegistryError(`resource "${input.id}": "dependsOn" entries must be non-empty strings`);
		}
		const entries = await this.readEntries();
		entries.set(input.id, {
			id: input.id,
			kind: "extension",
			...(input.entry !== undefined ? { entry: input.entry } : {}),
			dependsOn: input.dependsOn ?? [],
			alwaysOn: input.alwaysOn ?? false,
		});
		await this.writeEntries(entries);
	}

	/** Removes one entry; missing IDs are a loud error, not a no-op. */
	async remove(id: string): Promise<void> {
		const entries = await this.readEntries();
		if (!entries.delete(id)) {
			throw new RegistryError(`resource "${id}" not found in ${this.#filePath}`);
		}
		await this.writeEntries(entries);
	}
}
