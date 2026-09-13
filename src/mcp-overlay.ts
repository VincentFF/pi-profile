/**
 * McpOverlay: the PURE half of the profile-scoped MCP filter.
 *
 * `pi-mcp-adapter` has no runtime allowlist channel (ADR-0002 amendment), so
 * the profile's `mcp` declaration is enforced by a generated config file the
 * adapter reads as its "Pi global override" slot (the slot `--mcp-config`
 * replaces). The file is a DISABLE OVERLAY: entries carry no connection
 * parameters and no credentials — `{ "<server>": { "disabled": true } }` is
 * the adapter's own idiom for `/mcp disable`, and its config merge is
 * per-field, so a stub merges onto the definition owned by the user's own
 * file.
 *
 * One exception is structural: because the overlay file REPLACES the Pi
 * global slot, the servers the user keeps in that slot are carried over
 * verbatim from the sidecar (`mcp.user.json`); a hand-written slot file is
 * adopted into the sidecar before the first overwrite.
 *
 * `allowed` semantics:
 * - `"all"` — the profile declares no `mcp`: nothing is disabled.
 * - `[]` — every discovered server is disabled.
 * - `["github", …]` — everything outside the list is disabled.
 */

import path from "node:path";

import { isRecord } from "./json-file.ts";
import { matchesReference } from "./name-matching.ts";

/**
 * The generated overlay REPLACES the adapter's Pi-global slot, so it lives at
 * the slot's default path. The user's own Pi-global servers move to a sidecar
 * that this package never writes except when adopting a hand-written slot.
 */
export const MCP_SLOT_FILE_NAME = "mcp.json";
export const MCP_SOURCE_FILE_NAME = "mcp.user.json";
/** Top-level key marking a file as generated. The adapter ignores unknown
 *  top-level keys, so the marker never reaches it as configuration. */
export const MCP_GENERATED_MARKER = "piProfileSwitch";

/** The adapter's Pi-global slot: the generated overlay. */
export function mcpSlotPath(agentDir: string): string {
	return path.join(agentDir, MCP_SLOT_FILE_NAME);
}

/** The user-owned sidecar holding the Pi-global servers verbatim. */
export function mcpSourcePath(agentDir: string): string {
	return path.join(agentDir, MCP_SOURCE_FILE_NAME);
}

/** True when the document was produced by pi-profile-switch. */
export function isGeneratedOverlay(value: unknown): boolean {
	if (!isRecord(value)) return false;
	const marker = value[MCP_GENERATED_MARKER];
	return isRecord(marker) && marker.generated === true;
}

/** True for the credential-free stubs the overlay adds for servers defined in
 *  the adapter's other sources. */
export function isDisabledStub(value: unknown): boolean {
	return isRecord(value) && Object.keys(value).length === 1 && value.disabled === true;
}

/** Server names a profile's `mcp` references resolve to. `undefined` (the
 *  profile declares nothing) means "no filtering" and is reported as the
 *  literal `"all"`. Glob references follow the same rules as every other
 *  profile reference. */
export function resolveAllowedServers(
	refs: readonly string[] | undefined,
	discovered: readonly string[],
): readonly string[] | "all" {
	if (refs === undefined) return "all";
	const allowed = new Set<string>();
	for (const ref of refs) {
		for (const name of discovered) {
			if (matchesReference(ref, name)) allowed.add(name);
		}
	}
	return [...allowed];
}

export interface McpOverlayInput {
	/** Parsed Pi-global slot document, when the user has one. */
	slotDocument?: Record<string, unknown>;
	/** Server names defined in the adapter's other file sources. */
	otherServerNames: readonly string[];
	allowed: readonly string[] | "all";
}

/** Builds the overlay document. Server order is sorted so the serialized
 *  bytes are stable and a rewrite only happens on a real change. */
export function buildMcpOverlay(input: McpOverlayInput): Record<string, unknown> {
	const allowed = input.allowed === "all" ? undefined : new Set(input.allowed);
	const slotServers = isRecord(input.slotDocument?.mcpServers) ? input.slotDocument.mcpServers : {};
	const servers: Record<string, unknown> = {};
	for (const [name, definition] of Object.entries(slotServers)) {
		if (allowed === undefined || allowed.has(name) || !isRecord(definition)) {
			servers[name] = definition;
			continue;
		}
		servers[name] = { ...definition, disabled: true };
	}
	for (const name of input.otherServerNames) {
		if (name in servers) continue; // the slot's definition owns the name
		if (allowed === undefined || allowed.has(name)) continue;
		servers[name] = { disabled: true };
	}
	const document: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(input.slotDocument ?? {})) {
		if (key !== "mcpServers" && key !== MCP_GENERATED_MARKER) document[key] = value;
	}
	document[MCP_GENERATED_MARKER] = { generated: true, version: 1 };
	document.mcpServers = Object.fromEntries(
		Object.entries(servers).sort(([left], [right]) => left.localeCompare(right)),
	);
	return document;
}

/** Stable serialization: two runs with the same semantics produce the same
 *  bytes, so the writer can skip no-op writes. */
export function serializeMcpOverlay(document: Record<string, unknown>): string {
	return `${JSON.stringify(document, null, 2)}\n`;
}
