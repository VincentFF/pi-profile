/**
 * ResourceRegistry: reads the global extension resource registry
 * (`<agentDir>/resources.json`) and resolves logical IDs to entry paths,
 * including the recursive `dependsOn` closure.
 *
 * Ticket 02 covers the global registry only; project registry merge and ID
 * override arrive with ticket 03.
 *
 * Invariants:
 * - IDs are stable and unique within the file.
 * - Cycles, missing dependencies, and missing entry files fail activation
 *   loudly (RegistryError) — registry errors must never pass silently.
 * - The registry never orders entries; load order stays Pi's.
 */

import { stat } from "node:fs/promises";
import path from "node:path";

import { isRecord, readJsonFile } from "./json-file.ts";
import { PROFILE_SCHEMA_VERSION } from "./profile-catalog.ts";

export interface ResourceEntry {
	id: string;
	kind: "extension";
	/** Absolute path to the extension entry file. */
	entry: string;
	dependsOn: string[];
	alwaysOn: boolean;
}

export class RegistryError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RegistryError";
	}
}

function parseEntry(id: string, raw: unknown): ResourceEntry {
	if (!isRecord(raw)) {
		throw new RegistryError(`resource "${id}" must be an object`);
	}
	if (raw.kind !== "extension") {
		throw new RegistryError(`resource "${id}": "kind" must be "extension"`);
	}
	if (typeof raw.entry !== "string" || raw.entry.length === 0) {
		throw new RegistryError(`resource "${id}": "entry" must be a non-empty string`);
	}
	if (raw.dependsOn !== undefined && (!Array.isArray(raw.dependsOn) || raw.dependsOn.some((d) => typeof d !== "string"))) {
		throw new RegistryError(`resource "${id}": "dependsOn" must be an array of strings`);
	}
	if (raw.alwaysOn !== undefined && typeof raw.alwaysOn !== "boolean") {
		throw new RegistryError(`resource "${id}": "alwaysOn" must be a boolean`);
	}
	return {
		id,
		kind: "extension",
		entry: raw.entry,
		dependsOn: (raw.dependsOn as string[] | undefined) ?? [],
		alwaysOn: (raw.alwaysOn as boolean | undefined) ?? false,
	};
}

async function fileExists(filePath: string): Promise<boolean> {
	try {
		return (await stat(filePath)).isFile();
	} catch {
		return false;
	}
}

export class ResourceRegistry {
	readonly #entries: ReadonlyMap<string, ResourceEntry>;

	private constructor(entries: ReadonlyMap<string, ResourceEntry>) {
		this.#entries = entries;
	}

	/** Reads `<agentDir>/resources.json`. A missing file means an empty
	 *  registry; malformed content throws RegistryError. */
	static async load(agentDir: string): Promise<ResourceRegistry> {
		const registryPath = path.join(agentDir, "resources.json");
		const result = await readJsonFile(registryPath);
		if (!result.ok) {
			if (result.reason === "missing") return new ResourceRegistry(new Map());
			throw new RegistryError(`invalid JSON in ${registryPath}`);
		}
		const parsed = result.value;
		if (!isRecord(parsed)) {
			throw new RegistryError(`${registryPath}: registry must be an object`);
		}
		if (parsed.schemaVersion !== PROFILE_SCHEMA_VERSION) {
			throw new RegistryError(
				`${registryPath}: unsupported schemaVersion ${JSON.stringify(parsed.schemaVersion)} (expected ${PROFILE_SCHEMA_VERSION})`,
			);
		}
		if (!isRecord(parsed.resources)) {
			throw new RegistryError(`${registryPath}: "resources" must be an object mapping IDs to entries`);
		}
		const entries = new Map<string, ResourceEntry>();
		for (const [id, entry] of Object.entries(parsed.resources)) {
			entries.set(id, parseEntry(id, entry));
		}
		return new ResourceRegistry(entries);
	}

	get(id: string): ResourceEntry | undefined {
		return this.#entries.get(id);
	}

	list(): ResourceEntry[] {
		return [...this.#entries.values()];
	}

	/** Entries flagged `alwaysOn` — these load in every profile. */
	alwaysOn(): ResourceEntry[] {
		return this.list().filter((entry) => entry.alwaysOn);
	}

	/**
	 * Resolves the recursive dependency closure over `ids`, deduped.
	 * Throws RegistryError on unknown IDs (selected or depended-on), dependency
	 * cycles, or entry files missing on disk. The result carries no ordering
	 * semantics — Pi's implicit load order applies at activation.
	 */
	async closure(ids: string[]): Promise<ResourceEntry[]> {
		const resolved = new Map<string, ResourceEntry>();
		const visiting: string[] = [];
		const visit = async (id: string): Promise<void> => {
			if (resolved.has(id)) return;
			const cycleAt = visiting.indexOf(id);
			if (cycleAt !== -1) {
				const cycle = [...visiting.slice(cycleAt), id].join(" -> ");
				throw new RegistryError(`dependency cycle detected: ${cycle}`);
			}
			const entry = this.#entries.get(id);
			if (entry === undefined) {
				throw new RegistryError(`unknown resource: "${id}" is not registered`);
			}
			if (!(await fileExists(entry.entry))) {
				throw new RegistryError(`resource "${id}": entry file does not exist: ${entry.entry}`);
			}
			visiting.push(id);
			try {
				for (const dependency of entry.dependsOn) {
					await visit(dependency);
				}
			} finally {
				visiting.pop();
			}
			resolved.set(id, entry);
		};
		for (const id of ids) {
			await visit(id);
		}
		return [...resolved.values()];
	}
}
