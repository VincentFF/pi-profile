/**
 * ProfileCatalogStore: the WRITE side of a profile catalog file, kept
 * separate from the read-only ProfileCatalog.
 *
 * Invariants:
 * - Whole-file overwrites (pretty-printed, `schemaVersion 2` envelope).
 *   A version 1 file is read with its `extensions` fields dropped and is
 *   rewritten as version 2 on the next save; wizard saves never block on
 *   concurrent edits — re-read at write time, same-name conflicts resolve
 *   last-write-wins.
 * - Definitions are complete and self-contained: no inheritance fields
 *   (`extends`, merge, array append) exist or are accepted.
 * - Definitions are re-parsed through the catalog's own
 *   `parseProfileDefinition`, so anything written is loadable;
 *   "default" is built in and can never be written.
 * - Writes land in exactly one scope file (global or project).
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { isRecord, readJsonFile } from "./json-file.ts";
import {
	CatalogError,
	DEFAULT_PROFILE_NAME,
	parseCatalogDocument,
	parseProfileDefinition,
	PROFILE_SCHEMA_VERSION,
	type ProfileDefinition,
} from "./profile-catalog.ts";

export class ProfileCatalogStore {
	readonly #filePath: string;

	constructor(catalogPath: string) {
		this.#filePath = catalogPath;
	}

	/** Validated definitions: missing file → empty; malformed → CatalogError
	 *  (catalog errors never pass silently, even on the write path).
	 *  Version 1 files load with `extensions` dropped. */
	async readDefinitions(): Promise<Map<string, ProfileDefinition>> {
		const result = await readJsonFile(this.#filePath);
		if (!result.ok) {
			if (result.reason === "missing") return new Map();
			throw new CatalogError(`invalid JSON in ${this.#filePath}`);
		}
		if (!isRecord(result.value)) {
			throw new CatalogError(`${this.#filePath}: catalog must be an object`);
		}
		return parseCatalogDocument(result.value, this.#filePath).profiles;
	}

	/** Overwrites the file with the given definitions (last write wins). */
	async writeDefinitions(definitions: ReadonlyMap<string, ProfileDefinition>): Promise<void> {
		const profiles: Record<string, unknown> = {};
		for (const [name, definition] of [...definitions.entries()].sort(([a], [b]) => a.localeCompare(b))) {
			// Round-trip through the parser: only declared, validated fields
			// are written back (self-contained; no unknown keys survive).
			profiles[name] = parseProfileDefinition(name, definition);
		}
		await mkdir(path.dirname(this.#filePath), { recursive: true });
		await writeFile(
			this.#filePath,
			`${JSON.stringify({ schemaVersion: PROFILE_SCHEMA_VERSION, profiles }, null, 2)}\n`,
		);
	}

	/** Inserts or replaces one complete definition. */
	async upsert(name: string, definition: ProfileDefinition): Promise<void> {
		if (name.trim().length === 0) {
			throw new CatalogError(`profile name must be non-empty`);
		}
		if (name === DEFAULT_PROFILE_NAME) {
			throw new CatalogError(`"${DEFAULT_PROFILE_NAME}" is built in and must not be defined in the catalog`);
		}
		const definitions = await this.readDefinitions();
		// Validate before mutating: the wizard's definition must parse.
		definitions.set(name, parseProfileDefinition(name, definition));
		await this.writeDefinitions(definitions);
	}

	/** Removes one profile; unknown names are a loud error, not a no-op. */
	async remove(name: string): Promise<void> {
		const definitions = await this.readDefinitions();
		if (!definitions.delete(name)) {
			throw new CatalogError(`profile "${name}" not found in ${this.#filePath}`);
		}
		await this.writeDefinitions(definitions);
	}
}
