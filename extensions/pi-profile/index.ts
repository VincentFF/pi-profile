import { readFileSync } from "node:fs";
import path from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
	MCP_ALLOWLIST_EVENT,
	MCP_ALLOWLIST_VERSION,
	MissingMcpAdapterError,
	probeAdapterPresence,
} from "../../src/mcp-coordination.ts";

/**
 * pi-profile extension entry.
 *
 * Loaded into the spawned pi via `-e`. Responsibilities so far:
 * - Append the profile's declared instructions to Pi's fully built system
 *   prompt on every turn (`before_agent_start`), so the default prompt,
 *   AGENTS.md, and other extensions keep working.
 * - MCP coordination (ticket 04): when the launch plan declares `mcp`,
 *   probe pi-mcp-adapter over the event bus at session start and publish
 *   the profile's runtime server allowlist (memory-only; the adapter's
 *   `.pi/mcp.json` overlay is never written by pi-profile). No `mcp`
 *   declaration means no coordination at all — the adapter keeps its own
 *   discovered/enabled set (the `default` profile's native behavior).
 *
 * The launch plan is written by the launcher into the generated runtime
 * dir (`pi-profile.json`); the `/profile` command family lands in the
 * switching/CRUD tickets.
 */

interface LaunchPlan {
	profile?: string;
	source?: string;
	instructions?: string;
	mcp?: string[];
}

function readLaunchPlan(): LaunchPlan {
	const agentDir = process.env.PI_CODING_AGENT_DIR;
	if (agentDir === undefined) return {};
	try {
		const parsed: unknown = JSON.parse(readFileSync(path.join(agentDir, "pi-profile.json"), "utf8"));
		return typeof parsed === "object" && parsed !== null ? (parsed as LaunchPlan) : {};
	} catch {
		return {};
	}
}

function declaredMcpServers(plan: LaunchPlan): string[] | undefined {
	if (!Array.isArray(plan.mcp)) return undefined;
	const servers = plan.mcp.filter((name): name is string => typeof name === "string" && name.length > 0);
	return servers.length > 0 ? servers : undefined;
}

export default function piProfileExtension(pi: ExtensionAPI): void {
	const plan = readLaunchPlan();

	const instructions =
		typeof plan.instructions === "string" && plan.instructions.length > 0 ? plan.instructions : undefined;
	if (instructions !== undefined) {
		pi.on("before_agent_start", (event) => ({
			systemPrompt: `${event.systemPrompt}\n\n${instructions}`,
		}));
	}

	const mcpServers = declaredMcpServers(plan);
	if (mcpServers !== undefined) {
		const profile = typeof plan.profile === "string" ? plan.profile : "unknown";
		pi.on("session_start", (_event, ctx) => {
			if (!probeAdapterPresence(pi.events)) {
				const error = new MissingMcpAdapterError(profile);
				// Loud on both surfaces: the UI notification for interactive
				// sessions, the thrown error for Pi's extension-error reporting
				// (RPC sessions have no visible UI). The launcher already gates
				// adapter presence before spawn; this is the in-session backstop
				// for an adapter that was selected but failed to load.
				ctx.ui?.notify(error.message, "error");
				throw error;
			}
			pi.events.emit(MCP_ALLOWLIST_EVENT, {
				version: MCP_ALLOWLIST_VERSION,
				profile,
				servers: mcpServers,
			});
		});
	}
}
