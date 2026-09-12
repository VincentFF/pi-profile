/**
 * ProfileCatalog: reads profile definitions from the global catalog
 * (`<agentDir>/profiles.json`).
 *
 * Ticket 02 covers the global catalog only; the project catalog, same-name
 * replacement, and global fallback arrive with ticket 03.
 *
 * Invariants:
 * - The built-in `default` profile never exists in the file and cannot be
 *   redefined there.
 * - A malformed catalog fails loudly (CatalogError) rather than silently
 *   starting unfiltered.
 */

import path from "node:path";

import { isRecord, readJsonFile } from "./json-file.ts";

export const PROFILE_SCHEMA_VERSION = 1;
export const DEFAULT_PROFILE_NAME = "default";

export interface ProfileModel {
	provider: string;
	id: string;
	thinkingLevel?: string;
}

/** A profile definition as stored in a catalog file. All fields optional:
 *  undeclared fields leave Pi's behavior untouched (PRD default-first rule). */
export interface ProfileDefinition {
	label?: string;
	description?: string;
	skills?: string[];
	extensions?: string[];
	mcp?: string[];
	tools?: string[];
	model?: ProfileModel;
	instructions?: string;
}

/** Where a profile's definition came from. `project` arrives with ticket 03. */
export type ProfileSource = "builtin" | "global";

export interface ResolvedProfile {
	name: string;
	source: ProfileSource;
	definition: ProfileDefinition;
}

export class CatalogError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CatalogError";
	}
}

function readStringArray(value: unknown, field: string, profileName: string): string[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
		throw new CatalogError(`profile "${profileName}": "${field}" must be an array of strings`);
	}
	return value as string[];
}

function readOptionalString(value: unknown, field: string, profileName: string): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string") {
		throw new CatalogError(`profile "${profileName}": "${field}" must be a string`);
	}
	return value;
}

function parseDefinition(name: string, raw: unknown): ProfileDefinition {
	if (!isRecord(raw)) {
		throw new CatalogError(`profile "${name}" must be an object`);
	}
	const definition: ProfileDefinition = {};
	const label = readOptionalString(raw.label, "label", name);
	if (label !== undefined) definition.label = label;
	const description = readOptionalString(raw.description, "description", name);
	if (description !== undefined) definition.description = description;
	for (const field of ["skills", "extensions", "mcp", "tools"] as const) {
		const entries = readStringArray(raw[field], field, name);
		if (entries !== undefined) definition[field] = entries;
	}
	if (raw.model !== undefined) {
		if (!isRecord(raw.model) || typeof raw.model.provider !== "string" || typeof raw.model.id !== "string") {
			throw new CatalogError(`profile "${name}": "model" must be an object with string "provider" and "id"`);
		}
		const thinkingLevel = readOptionalString(raw.model.thinkingLevel, "model.thinkingLevel", name);
		definition.model = { provider: raw.model.provider, id: raw.model.id, ...(thinkingLevel ? { thinkingLevel } : {}) };
	}
	const instructions = readOptionalString(raw.instructions, "instructions", name);
	if (instructions !== undefined) definition.instructions = instructions;
	return definition;
}

export class ProfileCatalog {
	readonly #profiles: ReadonlyMap<string, ProfileDefinition>;

	private constructor(profiles: ReadonlyMap<string, ProfileDefinition>) {
		this.#profiles = profiles;
	}

	/** Reads `<agentDir>/profiles.json`. A missing file means an empty catalog;
	 *  malformed content throws CatalogError. */
	static async load(agentDir: string): Promise<ProfileCatalog> {
		const catalogPath = path.join(agentDir, "profiles.json");
		const result = await readJsonFile(catalogPath);
		if (!result.ok) {
			if (result.reason === "missing") return new ProfileCatalog(new Map());
			throw new CatalogError(`invalid JSON in ${catalogPath}`);
		}
		const parsed = result.value;
		if (!isRecord(parsed)) {
			throw new CatalogError(`${catalogPath}: catalog must be an object`);
		}
		if (parsed.schemaVersion !== PROFILE_SCHEMA_VERSION) {
			throw new CatalogError(
				`${catalogPath}: unsupported schemaVersion ${JSON.stringify(parsed.schemaVersion)} (expected ${PROFILE_SCHEMA_VERSION})`,
			);
		}
		if (!isRecord(parsed.profiles)) {
			throw new CatalogError(`${catalogPath}: "profiles" must be an object mapping names to definitions`);
		}
		const profiles = new Map<string, ProfileDefinition>();
		for (const [name, definition] of Object.entries(parsed.profiles)) {
			if (name === DEFAULT_PROFILE_NAME) {
				throw new CatalogError(
					`${catalogPath}: "${DEFAULT_PROFILE_NAME}" is built in and must not be defined in the catalog`,
				);
			}
			profiles.set(name, parseDefinition(name, definition));
		}
		return new ProfileCatalog(profiles);
	}

	/** Resolves a profile by name. `default` always resolves to the built-in
	 *  full-resource profile; unknown names return undefined. */
	resolve(name: string): ResolvedProfile | undefined {
		if (name === DEFAULT_PROFILE_NAME) {
			return { name: DEFAULT_PROFILE_NAME, source: "builtin", definition: {} };
		}
		const definition = this.#profiles.get(name);
		return definition === undefined ? undefined : { name, source: "global", definition };
	}

	/** Lists the built-in default first, then catalog profiles in file order. */
	list(): ResolvedProfile[] {
		return [
			this.resolve(DEFAULT_PROFILE_NAME)!,
			...[...this.#profiles.keys()].map((name) => this.resolve(name)!),
		];
	}
}
