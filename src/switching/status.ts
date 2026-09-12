/**
 * StatusReport: the `/profile status` observability surface (ticket 07).
 *
 * Pure report builder: combines the ACTIVE launch plan (what the runtime
 * was resolved to), the stored overlay, fresh MCP adapter discovery, and
 * Pi's actual command registrations (the winner evidence for same-name
 * conflicts). Markdown formatting is the only presentation; the extension
 * ships it via `pi.sendMessage`.
 *
 * Conflict semantics: Pi's load order is first-wins by scope/file order,
 * so the registered command IS the winner. A conflict is reported when the
 * plan resolved a skill whose command name is registered from a DIFFERENT
 * path (shadowed) or is absent (failed to load) — never blocked, always
 * visible.
 */

import type { RuntimeOverlay } from "../runtime-state-store.ts";
import type { LaunchPlanFile } from "./apply-plan.ts";

export interface StatusConflict {
	/** Command name as registered (e.g. `skill:review`). */
	name: string;
	/** The path the active plan resolved. */
	expectedPath: string;
	/** The path Pi actually registered (the winner), or "not loaded". */
	winnerPath: string;
}

export interface StatusReport {
	profile: string;
	source: string;
	overlay?: RuntimeOverlay;
	skills: Array<{ name: string; filePath: string }>;
	extensions: Array<{ id: string; entry: string }>;
	tools?: string[];
	mcp: { enabled: string[]; disabled: string[]; missing: string[] };
	/** Glob delta versus the previous activation (prefixed names). */
	delta?: { added: string[]; removed: string[] };
	conflicts: StatusConflict[];
}

interface RegisteredCommand {
	name: string;
	sourceInfo?: { path: string };
}

interface RegisteredTool {
	name: string;
	sourceInfo?: { path: string; source: string };
}

function currentNames(plan: LaunchPlanFile): string[] {
	const names = [
		...(plan.resolved?.skills ?? []).map((skill) => `skill:${skill.name}`),
		...(plan.resolved?.extensions ?? []).map((entry) => `extension:${entry.id}`),
		...(plan.tools ?? []).map((tool) => `tool:${tool}`),
		...(plan.mcp ?? []).map((server) => `mcp:${server}`),
	];
	return names.sort();
}

export function buildStatusReport(input: {
	plan: LaunchPlanFile;
	overlay?: RuntimeOverlay;
	discoveredMcpServers: string[];
	commands: RegisteredCommand[];
	tools: RegisteredTool[];
}): StatusReport {
	const { plan } = input;

	const enabled = plan.mcp ?? [];
	const discovered = new Set(input.discoveredMcpServers);
	const mcp = {
		enabled,
		disabled: input.discoveredMcpServers.filter((name) => !enabled.includes(name)),
		missing: enabled.filter((name) => !discovered.has(name)),
	};

	let delta: StatusReport["delta"];
	if (plan.previousResolved !== undefined) {
		const before = new Set(
			[
				...plan.previousResolved.skills.map((name) => `skill:${name}`),
				...plan.previousResolved.extensions.map((id) => `extension:${id}`),
				...(plan.previousResolved.tools ?? []).map((name) => `tool:${name}`),
				...(plan.previousResolved.mcp ?? []).map((name) => `mcp:${name}`),
			].sort(),
		);
		const after = new Set(currentNames(plan));
		const added = [...after].filter((name) => !before.has(name));
		const removed = [...before].filter((name) => !after.has(name));
		if (added.length > 0 || removed.length > 0) {
			delta = { added, removed };
		}
	}

	const conflicts: StatusConflict[] = [];
	for (const skill of plan.resolved?.skills ?? []) {
		const command = input.commands.find((entry) => entry.name === `skill:${skill.name}`);
		const winnerPath = command?.sourceInfo?.path;
		if (winnerPath === undefined) {
			conflicts.push({ name: `skill:${skill.name}`, expectedPath: skill.filePath, winnerPath: "not loaded" });
		} else if (winnerPath !== skill.filePath) {
			conflicts.push({ name: `skill:${skill.name}`, expectedPath: skill.filePath, winnerPath });
		}
	}

	// Tool conflicts: a plan tool whose registered winner is neither a pi
	// builtin nor a tool from one of the plan's selected extensions was
	// shadowed by (or shadows) an unexpected source.
	const extensionDirs = (plan.resolved?.extensions ?? []).map((entry) =>
		entry.entry.endsWith(".ts") ? entry.entry.slice(0, entry.entry.lastIndexOf("/")) : entry.entry,
	);
	for (const toolName of plan.tools ?? []) {
		const winner = input.tools.find((entry) => entry.name === toolName);
		const info = winner?.sourceInfo;
		if (info === undefined) continue; // unknown names are dropped by pi.setActiveTools
		const expected = info.source === "builtin" || extensionDirs.some((dir) => info.path.startsWith(dir));
		if (!expected) {
			conflicts.push({ name: `tool:${toolName}`, expectedPath: "builtin or selected extension", winnerPath: info.path });
		}
	}

	return {
		profile: plan.profile,
		source: plan.source,
		overlay: input.overlay,
		skills: plan.resolved?.skills ?? [],
		extensions: plan.resolved?.extensions ?? [],
		...(plan.tools !== undefined ? { tools: plan.tools } : {}),
		mcp,
		...(delta !== undefined ? { delta } : {}),
		conflicts,
	};
}

export function formatStatusMarkdown(report: StatusReport): string {
	const lines: string[] = [];
	lines.push(`### profile: ${report.profile} (${report.source})`);
	if (report.overlay !== undefined) {
		const parts = [
			...(report.overlay.disabledSkills ?? []).map((name) => `-skill:${name}`),
			...(report.overlay.disabledExtensions ?? []).map((id) => `-extension:${id}`),
			...(report.overlay.disabledMcp ?? []).map((name) => `-mcp:${name}`),
			...(report.overlay.tools !== undefined ? [`tools=[${report.overlay.tools.join(", ")}]`] : []),
		];
		lines.push(`overlay: ${parts.length > 0 ? parts.join(" ") : "(empty)"}`);
	}
	if (report.skills.length > 0) {
		lines.push("skills:");
		for (const skill of report.skills) {
			lines.push(`  ${skill.name} → ${skill.filePath}`);
		}
	}
	if (report.extensions.length > 0) {
		lines.push("extensions:");
		for (const extension of report.extensions) {
			lines.push(`  ${extension.id} → ${extension.entry}`);
		}
	}
	if (report.tools !== undefined) {
		lines.push(`tools: [${report.tools.join(", ")}]`);
	}
	lines.push(
		`mcp: enabled=[${report.mcp.enabled.join(", ")}] disabled=[${report.mcp.disabled.join(", ")}] missing=[${report.mcp.missing.join(", ")}]`,
	);
	if (report.delta !== undefined) {
		lines.push(`delta: +[${report.delta.added.join(", ")}] -[${report.delta.removed.join(", ")}]`);
	}
	for (const conflict of report.conflicts) {
		lines.push(
			`conflict: ${conflict.name} — plan resolved ${conflict.expectedPath}, Pi registered ${conflict.winnerPath} (Pi first-wins load order)`,
		);
	}
	return lines.join("\n");
}
