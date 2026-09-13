/**
 * McpCoordination: the pi-profile-switch ↔ pi-mcp-adapter contract (ADR-0002).
 *
 * The adapter's released versions (≤2.33) offer no in-memory server
 * allowlist, so pi-profile-switch defines the coordination channel the locked
 * adapter implements:
 *
 * - pi-profile-switch publishes the active profile's runtime server allowlist on
 *   `pi-profile:mcp-allowlist:v1` at activation (session start, `/profile
 *   use`, `customize`/`reset`, `/mcp enable|disable`). The allowlist is
 *   memory-only: pi-profile-switch never writes the adapter's `.pi/mcp.json`.
 * - Adapter presence is probed via the adapter's documented
 *   request/result event pattern: emit a snapshot request for a bogus
 *   server name; an installed adapter fills `request.result` synchronously
 *   (with `{ok: false}` — the name is bogus), an absent adapter leaves it
 *   undefined.
 *
 * Activation probes the adapter and refuses a profile whose declared MCP
 * intent cannot be satisfied before applying anything.
 */

/** pi-profile-switch's allowlist channel (the locked adapter subscribes). */
export const MCP_ALLOWLIST_EVENT = "pi-profile:mcp-allowlist:v1";
export const MCP_ALLOWLIST_VERSION = 1 as const;

export interface McpAllowlistMessage {
	version: typeof MCP_ALLOWLIST_VERSION;
	profile: string;
	servers: string[];
}

/** The adapter's snapshot channel, used here purely as a presence probe
 *  (see the module docblock). Kept as a literal so pi-profile-switch doesn't
 *  import adapter internals. */
export const MCP_ADAPTER_SNAPSHOT_EVENT = "pi-mcp-adapter:runtime-snapshot:v1";

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
