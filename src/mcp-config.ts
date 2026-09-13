/**
 * AdapterConfigDiscovery: reads what pi-mcp-adapter would load from its
 * pi-native FILE sources — server names for reference validation, and the
 * "Pi global override" slot document for the generated overlay.
 *
 * Discovery mirrors the adapter's own source order (later sources override
 * earlier ones): shared global MCP config, the two `.agents` globals, the Pi
 * global override slot (`--mcp-config`, else `<agentDir>/mcp.json`), then the
 * project's `.mcp.json` and `.pi/mcp.json` (project sources only when Pi
 * reports the project trusted — an untrusted project's config is never read).
 *
 * Not covered (documented limitation): the adapter's opt-in host discovery
 * (`~/.claude.json`, `~/.cursor/mcp.json`, …), package manifests (`pi.mcp`)
 * and agent/Claude plugin sources. Their servers are namespaced and cannot be
 * referenced by a profile today; the overlay still disables them when a name
 * happens to match one it knows.
 *
 * pi-profile-switch never writes these files and never exposes connection
 * parameters; the slot document is read only to be carried into the generated
 * overlay, because that file replaces the slot.
 *
 * Malformed config files fail loudly — a broken mcp.json must not silently
 * read as "no servers" and reject every reference.
 */

import { homedir } from "node:os";
import path from "node:path";

import { isRecord, readJsonFileSync } from "./json-file.ts";

export class McpConfigError extends Error {
	readonly filePath: string;

	constructor(message: string, filePath: string) {
		super(message);
		this.name = "McpConfigError";
		this.filePath = filePath;
	}
}

export interface AdapterMcpSource {
	label: string;
	filePath: string;
	scope: "global" | "project";
	/** True for the slot `--mcp-config` replaces. */
	slot: boolean;
}

export interface AdapterMcpDiscoveryInput {
	agentDir: string;
	cwd: string;
	projectTrusted: boolean;
	/** The effective `--mcp-config` value, when one is in play. */
	overridePath?: string;
	/** Home directory override; tests point this at their fixture. */
	homeDir?: string;
}

/** The adapter's file sources, in its own precedence order. Paths are
 *  de-duplicated: the adapter skips a source whose read path equals the slot. */
export function adapterMcpSources(input: AdapterMcpDiscoveryInput): AdapterMcpSource[] {
	const home = input.homeDir ?? homedir();
	const slotPath = path.resolve(input.overridePath ?? path.join(input.agentDir, "mcp.json"));
	const candidates: AdapterMcpSource[] = [
		{ label: "shared global MCP config", filePath: path.join(home, ".config", "mcp", "mcp.json"), scope: "global", slot: false },
		{ label: ".agents MCP config", filePath: path.join(home, ".agents", "mcp.json"), scope: "global", slot: false },
		{ label: ".agents/mcp MCP config", filePath: path.join(home, ".agents", "mcp", "mcp.json"), scope: "global", slot: false },
		{ label: "Pi global MCP override", filePath: slotPath, scope: "global", slot: true },
	];
	if (input.projectTrusted) {
		candidates.push(
			{ label: "project MCP config", filePath: path.resolve(input.cwd, ".mcp.json"), scope: "project", slot: false },
			{ label: "project Pi MCP override", filePath: path.resolve(input.cwd, ".pi", "mcp.json"), scope: "project", slot: false },
		);
	}
	const seen = new Set<string>();
	return candidates.filter((source) => {
		if (source.slot) return true; // the slot is always the read path
		if (seen.has(source.filePath)) return false;
		seen.add(source.filePath);
		return true;
	});
}

export interface AdapterMcpView {
	/** Read path of the slot `--mcp-config` replaces. */
	slotPath: string;
	/** Parsed slot document (verbatim), when the file exists. */
	slotDocument?: Record<string, unknown>;
	slotNames: string[];
	/** Server names from the other file sources. */
	otherNames: string[];
	/** Union of slot and other names, sorted. */
	serverNames: string[];
}

/** Synchronous read: the extension-load pass must finish before the adapter's
 *  session initialization, and the files are tiny. */
export function readAdapterMcpViewSync(input: AdapterMcpDiscoveryInput): AdapterMcpView {
	const sources = adapterMcpSources(input);
	const slot = sources.find((source) => source.slot);
	const slotPath = slot?.filePath ?? path.join(input.agentDir, "mcp.json");
	let slotDocument: Record<string, unknown> | undefined;
	const slotNames: string[] = [];
	const otherNames = new Set<string>();
	for (const source of sources) {
		if (source.slot) {
			const document = readMcpDocumentSync(source.filePath);
			if (document === undefined) continue;
			slotDocument = document;
			slotNames.push(...serverNames(document, source.filePath));
			continue;
		}
		const document = readMcpDocumentSync(source.filePath);
		if (document === undefined) continue;
		for (const name of serverNames(document, source.filePath)) otherNames.add(name);
	}
	for (const name of slotNames) otherNames.delete(name);
	return {
		slotPath,
		...(slotDocument === undefined ? {} : { slotDocument }),
		slotNames,
		otherNames: [...otherNames].sort(),
		serverNames: [...new Set([...slotNames, ...otherNames])].sort(),
	};
}

/** Async twin for the runtime paths (selection, status, toggles). */
export async function readAdapterMcpView(input: AdapterMcpDiscoveryInput): Promise<AdapterMcpView> {
	return readAdapterMcpViewSync(input);
}

/** Server names from every source EXCEPT the slot file. The slot is generated
 *  by pi-profile-switch, so it must not feed back into the next generation —
 *  otherwise a stub would look like a source server and vanish on the next
 *  write. */
export function readAdapterOtherServerNamesSync(input: AdapterMcpDiscoveryInput): string[] {
	const names = new Set<string>();
	for (const source of adapterMcpSources(input)) {
		if (source.slot) continue;
		const document = readMcpDocumentSync(source.filePath);
		if (document === undefined) continue;
		for (const name of serverNames(document, source.filePath)) names.add(name);
	}
	return [...names].sort();
}

/** Server names the adapter would discover. `projectDir` is passed only when
 *  the trust check passed. */
export async function discoverAdapterServerNames(
	agentDir: string,
	projectDir?: string,
	homeDir?: string,
): Promise<string[]> {
	return readAdapterMcpViewSync({
		agentDir,
		cwd: projectDir ?? process.cwd(),
		projectTrusted: projectDir !== undefined,
		...(homeDir === undefined ? {} : { homeDir }),
	}).serverNames;
}

/** Missing file → undefined; malformed → McpConfigError. */
export function readMcpDocumentSync(filePath: string): Record<string, unknown> | undefined {
	const result = readJsonFileSync(filePath);
	if (!result.ok) {
		if (result.reason === "missing") return undefined;
		throw new McpConfigError(`MCP config is not valid JSON: ${filePath}`, filePath);
	}
	if (!isRecord(result.value)) {
		throw new McpConfigError(`MCP config must be a JSON object: ${filePath}`, filePath);
	}
	return result.value;
}

function serverNames(document: Record<string, unknown>, filePath: string): string[] {
	if (document.mcpServers === undefined) return [];
	if (!isRecord(document.mcpServers)) {
		throw new McpConfigError(`"mcpServers" must be a JSON object: ${filePath}`, filePath);
	}
	return Object.keys(document.mcpServers);
}
