/**
 * McpCoordination: the pi-profile ↔ pi-mcp-adapter contract (ADR-0002).
 *
 * The adapter's released versions (≤2.33) offer no in-memory server
 * allowlist, so pi-profile defines the coordination channel the locked
 * adapter implements:
 *
 * - pi-profile publishes the active profile's runtime server allowlist on
 *   `pi-profile:mcp-allowlist:v1` at session start (and after every profile
 *   switch reload, ticket 05). The allowlist is memory-only: pi-profile
 *   never writes the adapter's `.pi/mcp.json` overlay.
 * - Adapter presence is probed via the adapter's documented
 *   request/result event pattern: emit a snapshot request for a bogus
 *   server name; an installed adapter fills `request.result` synchronously
 *   (with `{ok: false}` — the name is bogus), an absent adapter leaves it
 *   undefined.
 *
 * Launch-time, the launcher additionally refuses to spawn when a profile
 * declares `mcp` but no active extension identifies as the adapter
 * (`isAdapterExtension`) — failing before spawn beats failing in-session.
 */

/** pi-profile's allowlist channel (the locked adapter subscribes). */
export const MCP_ALLOWLIST_EVENT = "pi-profile:mcp-allowlist:v1";
export const MCP_ALLOWLIST_VERSION = 1 as const;

export interface McpAllowlistMessage {
	version: typeof MCP_ALLOWLIST_VERSION;
	profile: string;
	servers: string[];
}

/** The adapter's snapshot channel, used here purely as a presence probe
 *  (see the module docblock). Kept as a literal so pi-profile doesn't
 *  import adapter internals. */
export const MCP_ADAPTER_SNAPSHOT_EVENT = "pi-mcp-adapter:runtime-snapshot:v1";

export class MissingMcpAdapterError extends Error {
	constructor(profile: string) {
		super(
			`profile "${profile}" declares MCP servers but pi-mcp-adapter is not active. ` +
				`Select the adapter in the profile's extensions (e.g. via its npm package) or remove the "mcps" declaration.`,
		);
		this.name = "MissingMcpAdapterError";
	}
}

/** Identifies the adapter among active extension entries by its install
 *  path containing "pi-mcp-adapter" (npm package roots and local dirs both
 *  match). Heuristic by design — activation-plan entries carry no package
 *  source string, and the in-session probe is the authoritative check. */
export function isAdapterExtension(entry: { entry: string }): boolean {
	return entry.entry.includes("pi-mcp-adapter");
}

/** True when the adapter answered the probe (filled `result` on the
 *  request object), regardless of the answer — presence, not health. */
export function probeAdapterPresence(events: { emit(channel: string, data: unknown): void }): boolean {
	const request: { version: 1; name: string; result?: unknown } = {
		version: 1,
		name: "pi-profile:presence-probe",
	};
	events.emit(MCP_ADAPTER_SNAPSHOT_EVENT, request);
	return request.result !== undefined;
}
