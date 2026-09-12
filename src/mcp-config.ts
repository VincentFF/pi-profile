/**
 * AdapterConfigDiscovery: reads the MCP server NAMES pi-mcp-adapter would
 * discover from its pi-native config files, without ever managing them.
 *
 * pi-profile never stores MCP connection parameters or credentials
 * (ADR-0002); this module reads only the `mcpServers` key names so the
 * launcher can validate a profile's `mcp` references before spawn.
 *
 * Discovery scope (documented limitation): the pi-native files only — the
 * global `<agentDir>/mcp.json` and, when trusted, the project's
 * `.pi/mcp.json`. Servers defined solely in the adapter's editor-specific
 * legacy locations (~/.claude/mcp.json et al.) are invisible here; profiles
 * referencing them fail launch validation. The pi-native files are the
 * adapter's documented default, and no in-session re-validation exists (the
 * adapter's status snapshots arrive too late and only post-init), so the
 * launch check is the only name validation — keep configs in the pi-native
 * files.
 *
 * Malformed config files fail loudly — a broken mcp.json must not silently
 * read as "no servers" and reject every reference.
 */

import { isRecord, readJsonFile } from "./json-file.ts";

export class McpConfigError extends Error {
	readonly filePath: string;

	constructor(message: string, filePath: string) {
		super(message);
		this.name = "McpConfigError";
		this.filePath = filePath;
	}
}

async function readServerNames(filePath: string): Promise<string[]> {
	const result = await readJsonFile(filePath);
	if (!result.ok) {
		if (result.reason === "missing") {
			return [];
		}
		throw new McpConfigError(`MCP config is not valid JSON: ${filePath}`, filePath);
	}
	if (!isRecord(result.value)) {
		throw new McpConfigError(`MCP config must be a JSON object: ${filePath}`, filePath);
	}
	if (result.value.mcpServers === undefined) {
		return [];
	}
	if (!isRecord(result.value.mcpServers)) {
		throw new McpConfigError(`"mcpServers" must be a JSON object: ${filePath}`, filePath);
	}
	return Object.keys(result.value.mcpServers);
}

/** Server names the adapter would discover: global agentDir config plus the
 *  trusted project's config. Pass `projectDir` only when the trust check
 *  passed — an untrusted project's config is never read. */
export async function discoverAdapterServerNames(agentDir: string, projectDir?: string): Promise<string[]> {
	const names = new Set(await readServerNames(`${agentDir}/mcp.json`));
	if (projectDir !== undefined) {
		for (const name of await readServerNames(`${projectDir}/.pi/mcp.json`)) {
			names.add(name);
		}
	}
	return [...names].sort();
}
