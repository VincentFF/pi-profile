/**
 * StartupMcpScope: derives the profile-scoped MCP overlay at times when a
 * full activation has not (or may not yet) run.
 *
 * Two callers:
 * - The extension-load pass: must be synchronous and must finish before
 *   pi-mcp-adapter reads its config at `session_start` (and, for eager
 *   servers, at its own load time). Pi applies CLI flag values only AFTER
 *   extension loading, so the `--profile` / `--mcp-config` values are read
 *   from argv here; trust is mirrored from Pi's own resolution order
 *   (`hasTrustRequiringProjectResources` → stored decision →
 *   `defaultProjectTrust`; an interactive first-time prompt is not yet
 *   answerable at load time and counts as untrusted).
 * - The switch pass: the caller already has the resolved allowlist, so the
 *   overlay is derived from it directly.
 *
 * The generated file IS the adapter's Pi-global slot (`<agentDir>/mcp.json`):
 * flag injection is impossible (Pi rejects two extensions registering the
 * same flag), so the mechanism works with the slot the adapter already reads.
 * The user's own Pi-global servers live in the sidecar `mcp.user.json`.
 *
 * Failure policy: a profile name that cannot be resolved (missing, malformed
 * catalog, unknown name) falls back to "no filtering" — the generated overlay
 * then changes nothing, and the real problem is reported loudly by the
 * activation that runs right after. A foreign `--mcp-config` disables
 * management entirely: the user's explicit file is never overwritten.
 */

import { hasTrustRequiringProjectResources, ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import path from "node:path";

import { isRecord, readJsonFileSync } from "./json-file.ts";
import { readAdapterOtherServerNamesSync, readMcpDocumentSync } from "./mcp-config.ts";
import {
	buildMcpOverlay,
	isDisabledStub,
	isGeneratedOverlay,
	MCP_GENERATED_MARKER,
	mcpSlotPath,
	mcpSourcePath,
	resolveAllowedServers,
	serializeMcpOverlay,
} from "./mcp-overlay.ts";
import { writeMcpOverlayIfChangedSync } from "./mcp-overlay-file.ts";
import { DEFAULT_PROFILE_NAME, parseCatalogDocument, type ProfileDefinition } from "./profile-catalog.ts";

/** Reads `--<name> <value>` / `--<name>=<value>` without Pi's parser (Pi
 *  applies extension flag values only after extension loading). Last wins. */
export function readFlagFromArgv(argv: readonly string[], name: string): string | undefined {
	const long = `--${name}`;
	let value: string | undefined;
	for (let index = 0; index < argv.length; index++) {
		const token = argv[index] ?? "";
		if (token === long) {
			const next = argv[index + 1];
			if (next !== undefined && !next.startsWith("--")) value = next;
			continue;
		}
		if (token.startsWith(`${long}=`)) {
			const inline = token.slice(long.length + 1);
			if (inline.length > 0) value = inline;
		}
	}
	return value;
}

/** True when Pi itself would consider `cwd` trusted right now. Mirrors
 *  `resolveProjectTrusted` minus extension votes and the interactive prompt. */
export function resolveProjectTrustedSync(agentDir: string, cwd: string): boolean {
	if (!hasTrustRequiringProjectResources(cwd)) return true;
	const stored = new ProjectTrustStore(agentDir).get(cwd);
	if (stored !== null) return stored;
	return readDefaultProjectTrustSync(agentDir) === "always";
}

/** The saved selection for this run: project state wins over global state
 *  (project state only when trusted), then the built-in default. */
export function resolveStartupProfileNameSync(input: {
	agentDir: string;
	cwd: string;
	projectTrusted: boolean;
	argv: readonly string[];
}): string {
	const requested = readFlagFromArgv(input.argv, "profile");
	if (requested !== undefined && requested.length > 0) return requested;
	const project = input.projectTrusted
		? readActiveProfile(path.join(input.cwd, ".pi", "pi-profile-state.json"))
		: undefined;
	return project ?? readActiveProfile(path.join(input.agentDir, "pi-profile-state.json")) ?? DEFAULT_PROFILE_NAME;
}

export interface McpOverlaySyncInput {
	agentDir: string;
	cwd: string;
	/** Pi's trust decision. Omitted on the extension-load pass, where Pi has
	 *  not resolved trust yet; the module mirrors Pi's own order then. */
	projectTrusted?: boolean;
	/** Effective `--mcp-config`; undefined means the managed overlay path. */
	overridePath?: string;
	/** The command line, for the load pass (Pi applies flag values only after
	 *  extension loading, so `--profile` is read from here). */
	argv?: readonly string[];
	homeDir?: string;
}

export interface McpOverlaySyncResult {
	overlayPath: string;
	/** False when a foreign `--mcp-config` owns the adapter's slot. */
	managed: boolean;
	changed: boolean;
	/** Set when nothing was written; the caller surfaces it as a warning. */
	error?: string;
}

/** Load-time (and `session_start` re-check) pass. `profileName` short-circuits
 *  the state lookup when the caller already activated a profile. */
export function syncStartupMcpOverlay(
	input: McpOverlaySyncInput & { profileName?: string; mcpRefs?: readonly string[] | undefined },
): McpOverlaySyncResult {
	try {
		const trust = input.projectTrusted;
		const profileName =
			input.profileName ??
			resolveStartupProfileNameSync({
				agentDir: input.agentDir,
				cwd: input.cwd,
				projectTrusted: trust ?? resolveProjectTrustedSync(input.agentDir, input.cwd),
				argv: input.argv ?? [],
			});
		const refs = input.mcpRefs ?? readProfileMcpRefsSync({ ...input, name: profileName, trust });
		return writeOverlayForRefs({ ...input, refs });
	} catch (error) {
		return {
			overlayPath: mcpSlotPath(input.agentDir),
			managed: true,
			changed: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

/** Switch pass: the caller already resolved the allowlist. */
export function syncMcpOverlayForSelection(
	input: McpOverlaySyncInput & { allowed: readonly string[] | "all" },
): McpOverlaySyncResult {
	try {
		return writeOverlay({ ...input, refs: input.allowed });
	} catch (error) {
		return {
			overlayPath: mcpSlotPath(input.agentDir),
			managed: true,
			changed: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

function writeOverlayForRefs(input: McpOverlaySyncInput & { refs: readonly string[] | undefined | "unknown" }): McpOverlaySyncResult {
	// An unresolvable profile is not an error here: the generated overlay
	// then filters nothing and the activation reports the real problem.
	const refs = input.refs === "unknown" ? undefined : input.refs;
	return writeOverlay({ ...input, refs });
}

function writeOverlay(input: McpOverlaySyncInput & { refs: readonly string[] | undefined | "all" }): McpOverlaySyncResult {
	const overlayPath = mcpSlotPath(input.agentDir);
	if (input.overridePath !== undefined && path.resolve(input.overridePath) !== overlayPath) {
		return { overlayPath, managed: false, changed: false };
	}
	const projectTrusted = input.projectTrusted ?? resolveProjectTrustedSync(input.agentDir, input.cwd);
	const discovery = {
		agentDir: input.agentDir,
		cwd: input.cwd,
		projectTrusted,
		...(input.homeDir === undefined ? {} : { homeDir: input.homeDir }),
	};
	// The slot is ours; a slot written by hand is adopted into the sidecar
	// before the first overwrite, so a user's Pi-global servers survive.
	const sourcePath = mcpSourcePath(input.agentDir);
	adoptHandWrittenSlotSync(overlayPath, sourcePath);
	const sourceDocument = readMcpDocumentSync(sourcePath);
	const sourceNames = isRecord(sourceDocument?.mcpServers) ? Object.keys(sourceDocument.mcpServers) : [];
	const otherNames = readAdapterOtherServerNamesSync(discovery);
	const allowed =
		input.refs === "all"
			? "all"
			: resolveAllowedServers(input.refs, [...new Set([...sourceNames, ...otherNames])].sort());
	const content = serializeMcpOverlay(
		buildMcpOverlay({
			...(sourceDocument === undefined ? {} : { slotDocument: sourceDocument }),
			otherServerNames: otherNames,
			allowed,
		}),
	);
	return { overlayPath, managed: true, changed: writeMcpOverlayIfChangedSync(overlayPath, content) };
}

/** A slot file without the generated marker holds the user's own Pi-global
 *  servers (from before this package managed the slot, or from a manual
 *  edit). Move them — plus the slot's non-server keys — into the sidecar
 *  before the slot is overwritten. Stub entries are skipped: they describe
 *  servers owned by the adapter's other sources. */
function adoptHandWrittenSlotSync(slotPath: string, sourcePath: string): void {
	const slot = readMcpDocumentSync(slotPath);
	if (slot === undefined || isGeneratedOverlay(slot)) return;
	const sidecar = readMcpDocumentSync(sourcePath) ?? {};
	const sidecarServers = isRecord(sidecar.mcpServers) ? sidecar.mcpServers : {};
	const servers: Record<string, unknown> = { ...sidecarServers };
	const slotServers = isRecord(slot.mcpServers) ? slot.mcpServers : {};
	for (const [name, definition] of Object.entries(slotServers)) {
		if (isDisabledStub(definition)) continue;
		servers[name] = definition;
	}
	const document: Record<string, unknown> = { ...sidecar };
	delete document[MCP_GENERATED_MARKER];
	for (const [key, value] of Object.entries(slot)) {
		if (key === "mcpServers" || key === MCP_GENERATED_MARKER) continue;
		document[key] = value;
	}
	document.mcpServers = Object.fromEntries(Object.entries(servers).sort(([left], [right]) => left.localeCompare(right)));
	writeMcpOverlayIfChangedSync(sourcePath, `${JSON.stringify(document, null, 2)}\n`);
}

function readActiveProfile(statePath: string): string | undefined {
	const result = readJsonFileSync(statePath);
	if (!result.ok || !isRecord(result.value)) return undefined;
	const name = result.value.activeProfile;
	return typeof name === "string" && name.length > 0 ? name : undefined;
}

/** The profile's raw `mcp` references; `"unknown"` when the profile or its
 *  catalog cannot be read (caller falls back to "no filtering"). */
function readProfileMcpRefsSync(
	input: McpOverlaySyncInput & { name: string; trust: boolean | undefined },
): readonly string[] | undefined | "unknown" {
	if (input.name === DEFAULT_PROFILE_NAME) return undefined;
	const trusted = input.trust ?? resolveProjectTrustedSync(input.agentDir, input.cwd);
	const global = readCatalogSync(path.join(input.agentDir, "profiles.json"));
	const project = trusted
		? readCatalogSync(path.join(input.cwd, ".pi", "profiles.json"))
		: new Map<string, ProfileDefinition>();
	if (global === "error" || project === "error") return "unknown";
	const definition = project.get(input.name) ?? global.get(input.name);
	return definition === undefined ? "unknown" : definition.mcp;
}

function readCatalogSync(filePath: string): Map<string, ProfileDefinition> | "error" {
	const result = readJsonFileSync(filePath);
	if (!result.ok) return result.reason === "missing" ? new Map<string, ProfileDefinition>() : "error";
	try {
		return parseCatalogDocument(result.value, filePath);
	} catch {
		return "error";
	}
}

function readDefaultProjectTrustSync(agentDir: string): string | undefined {
	const result = readJsonFileSync(path.join(agentDir, "settings.json"));
	if (!result.ok || !isRecord(result.value)) return undefined;
	const value = result.value.defaultProjectTrust;
	return typeof value === "string" ? value : undefined;
}
