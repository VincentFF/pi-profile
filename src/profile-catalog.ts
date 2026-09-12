/**
 * ProfileCatalog: reads profile definitions from the global catalog
 * (`<agentDir>/profiles.json`) and, for trusted projects, the project
 * catalog (`<projectDir>/.pi/profiles.json`).
 *
 * Invariants:
 * - The built-in `default` profile never exists in either file and cannot be
 *   redefined there.
 * - A project profile with the same name fully replaces the global
 *   definition (no merge, no inheritance); removing the project entry
 *   immediately reveals the global one.
 * - The caller passes `projectDir` only when the resolver's trust check
 *   passed — an untrusted project's catalog is never read.
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

/** Where a profile's definition came from. */
export type ProfileSource = "builtin" | "global" | "project";

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

/** Reads one catalog file; missing → empty map, malformed → CatalogError. */
async function loadCatalogFile(catalogPath: string): Promise<Map<string, ProfileDefinition>> {
	const result = await readJsonFile(catalogPath);
	const profiles = new Map<string, ProfileDefinition>();
	if (!result.ok) {
		if (result.reason === "missing") return profiles;
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
	for (const [name, definition] of Object.entries(parsed.profiles)) {
		if (name === DEFAULT_PROFILE_NAME) {
			throw new CatalogError(
				`${catalogPath}: "${DEFAULT_PROFILE_NAME}" is built in and must not be defined in the catalog`,
			);
		}
		profiles.set(name, parseDefinition(name, definition));
	}
	return profiles;
}

export class ProfileCatalog {
	readonly #profiles: ReadonlyMap<string, { source: "global" | "project"; definition: ProfileDefinition }>;

	private constructor(profiles: ReadonlyMap<string, { source: "global" | "project"; definition: ProfileDefinition }>) {
		this.#profiles = profiles;
	}

	/**
	 * Reads the global catalog, plus the project catalog when `projectDir` is
	 * given (trusted projects only — the caller gates on the trust check).
	 * Missing files mean an empty catalog; malformed content throws
	 * CatalogError. Project entries replace same-name global entries.
	 */
	static async load(agentDir: string, options?: { projectDir?: string }): Promise<ProfileCatalog> {
		const globalProfiles = await loadCatalogFile(path.join(agentDir, "profiles.json"));
		const profiles = new Map<string, { source: "global" | "project"; definition: ProfileDefinition }>();
		for (const [name, definition] of globalProfiles) {
			profiles.set(name, { source: "global", definition });
		}
		if (options?.projectDir !== undefined) {
			const projectProfiles = await loadCatalogFile(path.join(options.projectDir, ".pi", "profiles.json"));
			for (const [name, definition] of projectProfiles) {
				profiles.set(name, { source: "project", definition });
			}
		}
		return new ProfileCatalog(profiles);
	}

	/** Resolves a profile by name. `default` always resolves to the built-in
	 *  full-resource profile; unknown names return undefined. */
	resolve(name: string): ResolvedProfile | undefined {
		if (name === DEFAULT_PROFILE_NAME) {
			return { name: DEFAULT_PROFILE_NAME, source: "builtin", definition: {} };
		}
		const entry = this.#profiles.get(name);
		return entry === undefined ? undefined : { name, source: entry.source, definition: entry.definition };
	}

	/** Lists the built-in default first, then profiles in file order (global
	 *  entries in global order, project-only names appended after). */
	list(): ResolvedProfile[] {
		return [
			this.resolve(DEFAULT_PROFILE_NAME)!,
			...[...this.#profiles.keys()].map((name) => this.resolve(name)!),
		];
	}
}
