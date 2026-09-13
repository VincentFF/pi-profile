/**
 * ResourceRegistry: the merged view of selectable extensions (ADR-0006).
 *
 * Two layers, merged at load:
 * - Implicit discovery (see extension-discovery.ts): installed packages'
 *   `pi.extensions` entries (referenced by package name or source alias)
 *   and loose files in the standard extensions dirs (referenced by filename
 *   stem). Zero configuration — the common case.
 * - Explicit registry files: global `<agentDir>/resources.json` and, for
 *   trusted projects, `<projectDir>/.pi/resources.json` (same-ID project
 *   entries override global ones). Explicit entries always win over implicit
 *   ones with the same ID and may omit `entry` to inherit the implicit
 *   entry — registration is the override, never the prerequisite.
 *
 * Invariants:
 * - IDs are stable and unique within the merged registry.
 * - Cycles, missing dependencies, and missing entry files fail activation
 *   loudly (RegistryError) — registry errors must never pass silently.
 * - The registry never orders entries; load order stays Pi's.
 * - The caller passes `projectDir` only when the resolver's trust check
 *   passed — an untrusted project's registry is never read.
 */

import { stat } from "node:fs/promises";
import path from "node:path";

import type { DiscoveredPackage, ImplicitExtensionDiscovery } from "./extension-discovery.ts";
import { isRecord, readJsonFile } from "./json-file.ts";
import { PROFILE_SCHEMA_VERSION } from "./profile-catalog.ts";

export interface ResourceEntry {
	id: string;
	kind: "extension";
	/** Absolute path to the extension entry file (inherited from implicit
	 *  discovery when an explicit override omits it). */
	entry: string;
	dependsOn: string[];
	alwaysOn: boolean;
	/** Where the entry came from: an explicit registry file, an installed
	 *  package, a loose extensions-dir file, or a profile's direct path
	 *  reference (ad-hoc, never stored). */
	origin: "explicit" | "package" | "local" | "path";
	/** For package-origin entries: the selectable package name. */
	packageName?: string;
}

/** The on-disk (explicit) entry shape: `entry` is optional so an override
 *  can inherit the implicit entry with the same ID. */
export interface RawResourceEntry {
	id: string;
	kind: "extension";
	entry?: string;
	dependsOn: string[];
	alwaysOn: boolean;
}

export class RegistryError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RegistryError";
	}
}

/** Parses one raw registry entry; exported for the write-side store
 *  (resource-registry-store.ts) so anything written is loadable. `entry` is
 *  optional: an override matching a discovered extension inherits its entry
 *  at load time. */
export function parseResourceEntry(id: string, raw: unknown): RawResourceEntry {
	if (!isRecord(raw)) {
		throw new RegistryError(`resource "${id}" must be an object`);
	}
	if (raw.kind !== "extension") {
		throw new RegistryError(`resource "${id}": "kind" must be "extension"`);
	}
	if (raw.entry !== undefined && (typeof raw.entry !== "string" || raw.entry.length === 0)) {
		throw new RegistryError(`resource "${id}": "entry" must be a non-empty string when present`);
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
		entry: raw.entry as string | undefined,
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

/** Reads one registry file; missing → empty map, malformed → RegistryError. */
async function loadRegistryFile(registryPath: string): Promise<Map<string, RawResourceEntry>> {
	const result = await readJsonFile(registryPath);
	const entries = new Map<string, RawResourceEntry>();
	if (!result.ok) {
		if (result.reason === "missing") return entries;
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
	for (const [id, entry] of Object.entries(parsed.resources)) {
		entries.set(id, parseResourceEntry(id, entry));
	}
	return entries;
}

function toPosix(filePath: string): string {
	return filePath.split(path.sep).join("/");
}

/** Merges one explicit entry over the implicit base with the same ID. The
 *  explicit entry wins every field it sets; `entry` may be inherited from
 *  the implicit base. An explicit entry with no implicit base and no
 *  `entry` of its own is DANGLING (package uninstalled?): it stays pending
 *  and fails loudly only when actually referenced — load-time failure would
 *  break unrelated profiles, mirroring how missing entry files fail at
 *  selection time, not at load. */
function mergeExplicit(raw: RawResourceEntry, implicitBase: ResourceEntry | undefined): ResourceEntry | undefined {
	const entry = raw.entry ?? implicitBase?.entry;
	if (entry === undefined) {
		return undefined;
	}
	return {
		id: raw.id,
		kind: "extension",
		entry,
		dependsOn: raw.dependsOn,
		alwaysOn: raw.alwaysOn,
		origin: "explicit",
		...(implicitBase?.packageName !== undefined ? { packageName: implicitBase.packageName } : {}),
	};
}

/** The error for referencing a dangling entry-less override. */
function danglingError(id: string): RegistryError {
	return new RegistryError(
		`resource "${id}" has no entry: it overrides a discovered extension that no longer exists ` +
			`(package uninstalled?) — reinstall it, add "entry" to the override, or delete the override`,
	);
}

/** True when a reference reads as a filesystem path rather than a name. */
function looksLikePath(reference: string): boolean {
	return (
		reference.startsWith("/") ||
		reference.startsWith("~/") ||
		reference.startsWith("./") ||
		reference.startsWith("../") ||
		/\.(ts|js)$/.test(reference)
	);
}

export interface SelectResult {
	/** Selected entries, deduped by entry path. Ad-hoc path references appear
	 *  as origin "path" entries and are NOT in the registry map (closure and
	 *  overlay logic must treat them separately). */
	entries: ResourceEntry[];
	/** Glob references that matched nothing this resolution (a warning, not
	 *  an error — new matches join on the next start or reload). */
	unmatched: string[];
}

export class ResourceRegistry {
	readonly #entries: ReadonlyMap<string, ResourceEntry>;
	/** Entry-less explicit overrides with no implicit base (dangling).
	 *  Referencing one fails loudly; a dangling alwaysOn ID joins every
	 *  named profile's closure so safety gates fail closed, never silently. */
	readonly #pending: ReadonlyMap<string, RawResourceEntry>;
	readonly #packages: readonly DiscoveredPackage[];
	readonly #warnings: string[];

	private constructor(
		entries: ReadonlyMap<string, ResourceEntry>,
		pending: ReadonlyMap<string, RawResourceEntry>,
		packages: readonly DiscoveredPackage[],
		warnings: string[],
	) {
		this.#entries = entries;
		this.#pending = pending;
		this.#packages = packages;
		this.#warnings = warnings;
	}

	/**
	 * Reads the implicit discovery result (packages + loose files), then the
	 * explicit registries on top (global, then project when `projectDir` is
	 * given — trusted projects only, the caller gates on the trust check).
	 * Missing files mean an empty explicit layer; malformed content throws
	 * RegistryError.
	 */
	static async load(
		agentDir: string,
		options?: { projectDir?: string; implicit?: ImplicitExtensionDiscovery },
	): Promise<ResourceRegistry> {
		const warnings = [...(options?.implicit?.warnings ?? [])];
		const entries = new Map<string, ResourceEntry>();
		const packages = options?.implicit?.packages ?? [];

		// Implicit layer: loose files first; packages then merge over them.
		// A package ID colliding with a loose-file ID loses the map slot (the
		// local file is the user's own code) but stays selectable through the
		// package's source alias (e.g. "npm:foo") — never silently shadowed.
		for (const local of options?.implicit?.local ?? []) {
			entries.set(local.id, {
				id: local.id,
				kind: "extension",
				entry: local.entry,
				dependsOn: [],
				alwaysOn: false,
				origin: "local",
			});
		}
		for (const pkg of packages) {
			for (const entryPath of pkg.entries) {
				const id = pkg.entries.length === 1 ? pkg.name : `${pkg.name}:${toPosix(path.relative(pkg.root, entryPath))}`;
				if (entries.has(id)) {
					warnings.push(
						`extension id "${id}" is provided by both a local file and package "${pkg.source}"; the local file wins — reference the package as "${pkg.source}" or register an explicit ID in resources.json`,
					);
					continue;
				}
				entries.set(id, {
					id,
					kind: "extension",
					entry: entryPath,
					dependsOn: [],
					alwaysOn: false,
					origin: "package",
					packageName: pkg.name,
				});
			}
		}

		// Explicit layer: global file, then project file (same-ID override).
		// Entry-less overrides with no implicit base dangle as pending entries:
		// non-alwaysOn ones only warn (unrelated profiles must not break);
		// alwaysOn ones additionally join every closure (fail-closed gates).
		const pending = new Map<string, RawResourceEntry>();
		const applyExplicit = (raw: RawResourceEntry): void => {
			const merged = mergeExplicit(raw, entries.get(raw.id));
			if (merged === undefined) {
				entries.delete(raw.id);
				pending.set(raw.id, raw);
				if (!raw.alwaysOn) {
					warnings.push(
						`resource "${raw.id}" has no entry and matches no discovered extension — reinstall the package, add "entry", or delete the override`,
					);
				}
				return;
			}
			pending.delete(raw.id);
			entries.set(raw.id, merged);
		};
		const globalEntries = await loadRegistryFile(path.join(agentDir, "resources.json"));
		for (const raw of globalEntries.values()) {
			applyExplicit(raw);
		}
		if (options?.projectDir !== undefined) {
			const projectEntries = await loadRegistryFile(path.join(options.projectDir, ".pi", "resources.json"));
			for (const raw of projectEntries.values()) {
				applyExplicit(raw);
			}
		}
		return new ResourceRegistry(entries, pending, packages, warnings);
	}

	get(id: string): ResourceEntry | undefined {
		return this.#entries.get(id);
	}

	list(): ResourceEntry[] {
		return [...this.#entries.values()];
	}

	/** Non-fatal merge notices (implicit ID collisions, discovery skips). */
	warnings(): string[] {
		return [...this.#warnings];
	}

	/** Entries flagged `alwaysOn` — these load in every profile. */
	alwaysOn(): ResourceEntry[] {
		return this.list().filter((entry) => entry.alwaysOn);
	}

	/** IDs that join every named profile's dependency closure: resolved
	 *  alwaysOn entries plus dangling alwaysOn overrides (which then fail
	 *  loudly in the closure — safety gates fail closed). */
	alwaysOnIds(): string[] {
		const ids = this.alwaysOn().map((entry) => entry.id);
		for (const [id, raw] of this.#pending) {
			if (raw.alwaysOn) ids.push(id);
		}
		return ids;
	}

	/** Selectable names for glob expansion and error guidance: entry IDs
	 *  plus package names (a package name selects all its entries). */
	selectableNames(): string[] {
		const names = new Set(this.#entries.keys());
		for (const pkg of this.#packages) names.add(pkg.name);
		return [...names].sort();
	}

	#packageByNameOrAlias(reference: string): DiscoveredPackage | undefined {
		return this.#packages.find((pkg) => pkg.name === reference || pkg.source === reference);
	}

	#packageEntries(pkg: DiscoveredPackage): ResourceEntry[] {
		return pkg.entries.map((entryPath) => {
			const id = pkg.entries.length === 1 ? pkg.name : `${pkg.name}:${toPosix(path.relative(pkg.root, entryPath))}`;
			// Prefer the merged map entry when it points at this same file
			// (explicit overrides and alwaysOn flags then apply); on an ID
			// collision with a loose file, synthesize the package's own entry —
			// the source alias must keep selecting the package.
			const existing = this.#entries.get(id);
			if (existing !== undefined && existing.entry === entryPath) return existing;
			return {
				id,
				kind: "extension",
				entry: entryPath,
				dependsOn: [],
				alwaysOn: false,
				origin: "package",
				packageName: pkg.name,
			};
		});
	}

	/**
	 * Resolves profile extension references (literals and globs) to entries.
	 *
	 * Literal precedence: merged registry ID → package name / source alias
	 * (selects all the package's entries) → on-disk path (ad-hoc entry) →
	 * RegistryError naming the discovered candidates, a did-you-mean when a
	 * name is close, and a minimal registration example for out-of-band
	 * files. Glob references match selectable names; zero matches is
	 * collected into `unmatched` (a warning, consistent with skills/MCP).
	 */
	async select(references: string[]): Promise<SelectResult> {
		const byPath = new Map<string, ResourceEntry>();
		const unmatched: string[] = [];
		const names = this.selectableNames();

		const add = (entry: ResourceEntry): void => {
			if (!byPath.has(entry.entry)) byPath.set(entry.entry, entry);
		};

		for (const reference of references) {
			if (reference.includes("*") || reference.includes("?")) {
				let matched = 0;
				for (const name of names) {
					if (!matchGlob(name, reference)) continue;
					matched += 1;
					const pkg = this.#packageByNameOrAlias(name);
					const entry = this.#entries.get(name);
					if (pkg !== undefined && pkg.name === name) {
						for (const pkgEntry of this.#packageEntries(pkg)) add(pkgEntry);
					}
					if (entry !== undefined) add(entry);
				}
				if (matched === 0) unmatched.push(reference);
				continue;
			}

			const entry = this.#entries.get(reference);
			if (entry !== undefined) {
				add(entry);
				continue;
			}
			if (this.#pending.has(reference)) {
				throw danglingError(reference);
			}
			const pkg = this.#packageByNameOrAlias(reference);
			if (pkg !== undefined) {
				const pkgEntries = this.#packageEntries(pkg);
				if (pkgEntries.length === 0) {
					throw new RegistryError(
						`package "${reference}" declares no extension entries (its pi.extensions files are missing or shadowed by local files)`,
					);
				}
				for (const pkgEntry of pkgEntries) add(pkgEntry);
				continue;
			}
			if (looksLikePath(reference)) {
				if (reference.startsWith("./") || reference.startsWith("../")) {
					throw new RegistryError(
						`extension reference "${reference}" is a relative path; profiles take absolute paths (or ~/...) — catalogs live in both global and project scope, so a relative base would be ambiguous`,
					);
				}
				const resolved = reference.startsWith("~/")
					? path.join(process.env.HOME ?? "", reference.slice(1))
					: path.resolve(reference);
				if (!(await fileExists(resolved))) {
					throw new RegistryError(`extension path not found: ${resolved}`);
				}
				add({ id: resolved, kind: "extension", entry: resolved, dependsOn: [], alwaysOn: false, origin: "path" });
				continue;
			}
			throw new RegistryError(this.#unknownMessage(reference, names));
		}
		return { entries: [...byPath.values()], unmatched };
	}

	#unknownMessage(reference: string, names: string[]): string {
		const lines = [
			`unknown extension: "${reference}" — no registry entry, installed package, extension file, or path matches it.`,
		];
		if (names.length > 0) {
			const shown = names.slice(0, 10);
			lines.push(`discovered: ${shown.join(", ")}${names.length > shown.length ? ` (+${names.length - shown.length} more)` : ""}`);
		}
		const suggestion = names.find(
			(name) =>
				name.toLowerCase().includes(reference.toLowerCase()) || reference.toLowerCase().includes(name.toLowerCase()),
		);
		if (suggestion !== undefined) {
			lines.push(`did you mean "${suggestion}"?`);
		}
		lines.push(
			`to reference an extension outside the discovered set, register it in resources.json:`,
			`  { "schemaVersion": 1, "resources": { "${reference}": { "kind": "extension", "entry": "/absolute/path/to/index.ts" } } }`,
		);
		return lines.join("\n");
	}

	/**
	 * Resolves the recursive dependency closure over `ids`, deduped.
	 * Throws RegistryError on unknown IDs (selected or depended-on), dependency
	 * cycles, or entry files missing on disk. The result carries no ordering
	 * semantics — Pi's implicit load order applies at activation.
	 *
	 * `preset` entries override map lookups by ID (e.g. select() results):
	 *  required when an alias-selected package entry shares its ID with a
	 *  different map entry. Dependency traversal and existence checks still run.
	 */
	async closure(ids: string[], preset?: ResourceEntry[]): Promise<ResourceEntry[]> {
		const overrides = new Map((preset ?? []).map((entry) => [entry.id, entry]));
		const resolved = new Map<string, ResourceEntry>();
		const visiting: string[] = [];
		const visit = async (id: string): Promise<void> => {
			if (resolved.has(id)) return;
			const cycleAt = visiting.indexOf(id);
			if (cycleAt !== -1) {
				const cycle = [...visiting.slice(cycleAt), id].join(" -> ");
				throw new RegistryError(`dependency cycle detected: ${cycle}`);
			}
			const entry = overrides.get(id) ?? this.#entries.get(id);
			if (entry === undefined) {
				if (this.#pending.has(id)) throw danglingError(id);
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

/** Minimal glob matcher for selectable names (supports `*` and `?`).
 *  The resolver's minimatch-based expandReferences handles other kinds;
 *  extension names are simple identifiers/paths, so a small matcher keeps
 *  this module dependency-light. */
function matchGlob(name: string, pattern: string): boolean {
	const regex = new RegExp(
		`^${pattern
			.replace(/[.+^${}()|[\]\\]/g, "\\$&")
			.replace(/\*/g, ".*")
			.replace(/\?/g, ".")}$`,
	);
	return regex.test(name);
}
