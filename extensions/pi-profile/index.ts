import { readFileSync } from "node:fs";
import path from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * pi-profile extension entry.
 *
 * Loaded into the spawned pi via `-e`. Ticket 02 scope: append the profile's
 * declared instructions to Pi's fully built system prompt on every turn
 * (`before_agent_start`), so the default prompt, AGENTS.md, and other
 * extensions keep working. The launch plan is written by the launcher into
 * the generated runtime dir (`pi-profile.json`); the `/profile` command
 * family lands in the switching/CRUD tickets.
 */

interface LaunchPlan {
	profile?: string;
	source?: string;
	instructions?: string;
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

export default function piProfileExtension(pi: ExtensionAPI): void {
	const plan = readLaunchPlan();
	const instructions = typeof plan.instructions === "string" && plan.instructions.length > 0 ? plan.instructions : undefined;
	if (instructions === undefined) return;
	pi.on("before_agent_start", (event) => ({
		systemPrompt: `${event.systemPrompt}\n\n${instructions}`,
	}));
}
