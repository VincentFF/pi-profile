/**
 * ExtensionDiscovery: implicit, read-only discovery of selectable extensions
 * (ADR-0006), so profiles can reference extensions without registering them
 * in resources.json first.
 *
 * Two implicit sources, both Pi-native and side-effect free:
 * - Configured user packages: each package's `package.json#pi.extensions`
 *   declares its extension entry files; the package name (or an alias like
 *   the `npm:` source string) is the profile-facing reference.
 * - Loose extension files: `<agentDir>/extensions/*.{ts,js}` and, for
 *   trusted projects, `<projectDir>/.pi/extensions/*.{ts,js}`, referenced by
 *   filename stem.
 *
 * Discovery never executes extension code and never installs anything: a
 * package contributes entries only for declared files that exist on disk.
 * Explicit resources.json entries merge over this discovery result in
 * ResourceRegistry.load (registration remains the override, never the
 * prerequisite).
 */

import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

import { isRecord } from "./json-file.ts";
import type { ConfiguredPackageRoot } from "./settings-generator.ts";

export interface DiscoveredPackage {
	/** Selectable package name: package.json "name", or the source minus its
	 *  npm:/git:/github: prefix (and any version spec) when unreadable. */
	name: string;
	/** The source string exactly as configured in the user's settings
	 *  (e.g. "npm:pi-mcp-adapter"); accepted as a reference alias. */
	source: string;
	/** Absolute install/local root of the package. */
	root: string;
	/** Absolute paths of declared `pi.extensions` entries that exist on disk. */
	entries: string[];
}

export interface DiscoveredLocalExtension {
	/** Selectable ID: the filename stem ("conventions" for conventions.ts). */
	id: string;
	entry: string;
}

export interface ImplicitExtensionDiscovery {
	packages: DiscoveredPackage[];
	/** Loose files, project entries already merged over same-ID global ones. */
	local: DiscoveredLocalExtension[];
	/** Non-fatal notices (skipped packages, shadowed duplicates). */
	warnings: string[];
}

const LOOSE_FILE_PATTERN = /\.(ts|js)$/;

async function exists(filePath: string): Promise<boolean> {
	try {
		return (await stat(filePath)).isFile();
	} catch {
		return false;
	}
}

/** Derives a package name from its source string when package.json is
 *  unreadable: strips the npm:/git:/github: prefix and any version spec
 *  (scoped names keep their "@scope/" prefix). */
export function packageNameFromSource(source: string): string {
	let name = source.replace(/^(npm|git|github):/, "");
	if (name.startsWith("@")) {
		// @scope/pkg[@version] — cut a version spec only after the scope path.
		const slash = name.indexOf("/");
		const versionAt = slash === -1 ? -1 : name.indexOf("@", slash);
		if (versionAt !== -1) name = name.slice(0, versionAt);
	} else {
		const versionAt = name.indexOf("@");
		if (versionAt !== -1) name = name.slice(0, versionAt);
	}
	return name;
}

/** Reads one installed package's declared extension entries. Packages
 *  without a readable package.json or without `pi.extensions` contribute
 *  nothing (skills-only packages are the common case). Declared entries
 *  missing on disk are skipped — the spawned pi reports load errors itself. */
async function readPackageExtensions(pkg: ConfiguredPackageRoot): Promise<DiscoveredPackage | undefined> {
	if (pkg.root === undefined) return undefined;
	let manifest: unknown;
	try {
		manifest = JSON.parse(await readFile(path.join(pkg.root, "package.json"), "utf8"));
	} catch {
		return undefined; // not installed yet or unreadable — nothing selectable
	}
	if (!isRecord(manifest)) return undefined;
	const pi = manifest.pi;
	const declared =
		isRecord(pi) && Array.isArray(pi.extensions) ? pi.extensions.filter((e): e is string => typeof e === "string") : [];
	if (declared.length === 0) return undefined;
	const entries: string[] = [];
	for (const rel of declared) {
		const entry = path.resolve(pkg.root, rel);
		if (await exists(entry)) entries.push(entry);
	}
	if (entries.length === 0) return undefined;
	const name = typeof manifest.name === "string" && manifest.name.length > 0 ? manifest.name : packageNameFromSource(pkg.source);
	return { name, source: pkg.source, root: pkg.root, entries };
}

/** Lists loose extension files in one directory; missing dir → empty.
 *  A `.ts`/`.js` stem pair resolves to the `.ts` file (Pi's convention:
 *  TypeScript sources are the canonical form) and is reported, not silent. */
async function scanLooseDir(dir: string, warnings: string[]): Promise<DiscoveredLocalExtension[]> {
	let files: string[];
	try {
		files = (await readdir(dir)).filter((name) => LOOSE_FILE_PATTERN.test(name));
	} catch {
		return [];
	}
	const byStem = new Map<string, string>();
	for (const name of files.sort()) {
		const stem = name.replace(LOOSE_FILE_PATTERN, "");
		const full = path.join(dir, name);
		const existing = byStem.get(stem);
		if (existing !== undefined) {
			if (!existing.endsWith(".ts") && name.endsWith(".ts")) {
				warnings.push(`extension "${stem}" exists as both .ts and .js in ${dir}; the .ts file is used`);
				byStem.set(stem, full);
			}
			continue;
		}
		byStem.set(stem, full);
	}
	return [...byStem.entries()].map(([id, entry]) => ({ id, entry }));
}

export async function discoverImplicitExtensions(options: {
	agentDir: string;
	/** Configured user-scope packages with resolved roots (launcher discovery). */
	packages: ConfiguredPackageRoot[];
	/** Trusted project dir; untrusted projects are never scanned. */
	projectDir?: string;
}): Promise<ImplicitExtensionDiscovery> {
	const warnings: string[] = [];

	const packages: DiscoveredPackage[] = [];
	for (const pkg of options.packages) {
		const discovered = await readPackageExtensions(pkg);
		if (discovered !== undefined) packages.push(discovered);
	}

	const globalLocal = await scanLooseDir(path.join(options.agentDir, "extensions"), warnings);
	const merged = new Map<string, DiscoveredLocalExtension>(globalLocal.map((entry) => [entry.id, entry]));
	if (options.projectDir !== undefined) {
		// Project loose files override same-ID global ones, mirroring the
		// catalog/registry override convention.
		for (const entry of await scanLooseDir(path.join(options.projectDir, ".pi", "extensions"), warnings)) {
			merged.set(entry.id, entry);
		}
	}

	return { packages, local: [...merged.values()], warnings };
}
