/**
 * StatusReport: the `/profile status` observability surface.
 *
 * Pure report builder: combines the ACTIVE selection (what the runtime was
 * resolved to), the stored overlay, and fresh MCP discovery. Markdown
 * formatting is the only presentation; the extension ships it via
 * `pi.sendMessage`.
 */

import type { ProfileSource } from "../profile-catalog.ts";
import type { ResolvedSelection, UnresolvedRef } from "../profile-resolver.ts";
import type { RuntimeOverlay } from "../runtime-state-store.ts";
import { visibleSkillNames, type SkillsFilterOutcome } from "../skill-selection.ts";

export interface StatusReport {
	profile: string;
	source: ProfileSource;
	overlay?: RuntimeOverlay;
	/** The skills the model can see (all loaded skills when unfiltered). */
	skills: {
		filtered: boolean;
		visible: Array<{ name: string; filePath: string }>;
		loaded: number;
		/** The last prompt-filter result; `no-filter` when the profile
		 *  selects nothing. */
		filterOutcome: SkillsFilterOutcome;
	};
	tools?: { active: string[]; pending: string[] };
	mcp: { enabled: string[]; discovered: string[]; missing: string[] };
	unresolved: { skills: UnresolvedRef[]; unmatched: string[] };
}

export function buildStatusReport(input: {
	selection: ResolvedSelection;
	allSkills: Array<{ name: string; filePath: string }>;
	discoveredMcpServers: string[];
	filterOutcome?: SkillsFilterOutcome;
}): StatusReport {
	const { selection } = input;
	const visibleNames = visibleSkillNames(input.allSkills, selection.skills);
	const visible =
		visibleNames === undefined
			? input.allSkills
			: input.allSkills.filter((skill) => visibleNames.includes(skill.name));

	const enabled = selection.mcp ?? [];
	const discovered = new Set(input.discoveredMcpServers);
	const unmatched = [
		...selection.warnings.skillsUnmatched,
		...selection.warnings.mcpUnmatched,
		...selection.warnings.toolsUnmatched,
	];

	return {
		profile: selection.name,
		source: selection.source,
		skills: {
			filtered: selection.skills !== undefined,
			visible,
			loaded: input.allSkills.length,
			filterOutcome: input.filterOutcome ?? (selection.skills === undefined ? "no-filter" : "filtered"),
		},
		...(selection.tools !== undefined
			? { tools: { active: selection.tools, pending: selection.pendingTools } }
			: {}),
		mcp: {
			enabled,
			discovered: input.discoveredMcpServers,
			missing: enabled.filter((name) => !discovered.has(name)),
		},
		unresolved: { skills: selection.warnings.skillsUnresolved, unmatched },
	};
}

export function formatStatusMarkdown(report: StatusReport): string {
	const lines: string[] = [];
	lines.push(`### profile: ${report.profile} (${report.source})`);
	if (report.overlay !== undefined) {
		const parts = [
			...(report.overlay.disabledSkills ?? []).map((name) => `-skill:${name}`),
			...(report.overlay.disabledMcp ?? []).map((name) => `-mcp:${name}`),
			...(report.overlay.tools !== undefined ? [`tools=[${report.overlay.tools.join(", ")}]`] : []),
		];
		lines.push(`overlay: ${parts.length > 0 ? parts.join(" ") : "(empty)"}`);
	}
	const skillScope = report.skills.filtered
		? `${report.skills.visible.length} of ${report.skills.loaded} loaded`
		: `all ${report.skills.loaded} loaded`;
	lines.push(`skills: ${skillScope}`);
	if (report.skills.filtered && report.skills.filterOutcome !== "filtered") {
		lines.push(`skills filter: not applied (${report.skills.filterOutcome})`);
	}
	for (const skill of report.skills.visible) {
		lines.push(`  ${skill.name} → ${skill.filePath}`);
	}
	if (report.tools !== undefined) {
		lines.push(`tools: [${report.tools.active.join(", ")}]`);
		if (report.tools.pending.length > 0) {
			lines.push(`tools pending (not registered yet): [${report.tools.pending.join(", ")}]`);
		}
	}
	lines.push(
		`mcp: enabled=[${report.mcp.enabled.join(", ")}] discovered=[${report.mcp.discovered.join(", ")}] missing=[${report.mcp.missing.join(", ")}]`,
	);
	for (const unresolved of report.unresolved.skills) {
		const hint = unresolved.suggestions.length > 0 ? ` — did you mean: ${unresolved.suggestions.join(", ")}?` : "";
		lines.push(`unresolved skill: ${unresolved.reference}${hint}`);
	}
	if (report.unresolved.unmatched.length > 0) {
		lines.push(`zero-match globs: [${report.unresolved.unmatched.join(", ")}]`);
	}
	return lines.join("\n");
}
