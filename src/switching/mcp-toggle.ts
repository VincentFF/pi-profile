/**
 * McpToggle: persistent, profile-scoped `/mcp enable|disable` (ticket 10).
 *
 * The profile's `mcp` array in its OWNING catalog is the profile-scoped
 * state store (ticket 04 established that pi-mcp-adapter@2.33.0 has no
 * allowlist/profile-state API — ADR-0002's assumed store does not exist;
 * pi-profile owns the contract). Runtime effect flows through the standard
 * rewrite-settings-and-reload path: the post-reload session_start
 * republishes the allowlist over the coordination channel.
 *
 * Invariants:
 * - Enable accepts only adapter-discovered names (fail fast on typos);
 *   disable also removes names the adapter no longer reports (stale
 *   cleanup).
 * - The built-in default profile has no catalog entry — toggling it is a
 *   clear error, not a synthetic write.
 * - Only the ACTIVE profile's array changes; other profiles and the
 *   adapter's own configuration (global mcp.json, project .pi/mcp.json)
 *   are never modified.
 */

import { discoverAdapterServerNames } from "../mcp-config.ts";
import { CatalogError, DEFAULT_PROFILE_NAME, type ProfileDefinition } from "../profile-catalog.ts";
import { readTrustInputs as readTrust } from "../launcher/initial-profile.ts";
import { catalogStore, readCatalogScope, type CatalogScope } from "./profile-crud.ts";

export async function setMcpServerEnabled(
	input: { realAgentDir: string; cwd: string; profile: { name: string; source: string } },
	server: string,
	enabled: boolean,
): Promise<{ mcp: string[]; changed: boolean }> {
	if (input.profile.name === DEFAULT_PROFILE_NAME || input.profile.source === "builtin") {
		throw new CatalogError(
			`the built-in default profile has no catalog entry — create a named profile (/profile create) to toggle MCP servers`,
		);
	}
	const scope = input.profile.source as CatalogScope;
	if (scope !== "global" && scope !== "project") {
		throw new CatalogError(`profile "${input.profile.name}" has no writable owning catalog (source: ${input.profile.source})`);
	}

	const { projectTrusted } = await readTrust({ agentDir: input.realAgentDir, cwd: input.cwd });
	if (scope === "project" && !projectTrusted) {
		throw new CatalogError(`project catalog is unavailable: ${input.cwd} is not trusted`);
	}
	const discovered = await discoverAdapterServerNames(input.realAgentDir, projectTrusted ? input.cwd : undefined);
	if (enabled && !discovered.includes(server)) {
		throw new CatalogError(
			`unknown MCP server "${server}" — adapter discovered: [${discovered.join(", ") || "(none)"}]`,
		);
	}

	const definitions = await readCatalogScope(input, scope);
	const definition = definitions.get(input.profile.name);
	if (definition === undefined) {
		throw new CatalogError(`profile "${input.profile.name}" not found in the ${scope} catalog`);
	}

	const current = definition.mcp ?? [];
	if (enabled === current.includes(server)) {
		return { mcp: current, changed: false }; // already in the requested state
	}
	const next = enabled ? [...current, server] : current.filter((name) => name !== server);
	// Drop the key entirely when empty (exactOptionalPropertyTypes; a
	// written `mcp: undefined` would also misrepresent the definition).
	const rest = { ...definition };
	delete rest.mcp;
	const updated: ProfileDefinition = next.length > 0 ? { ...rest, mcp: next } : rest;
	await catalogStore(input, scope).upsert(input.profile.name, updated);
	return { mcp: next, changed: true };
}
