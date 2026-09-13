/**
 * SkillSelection: the skills visibility filter (ADR-0007).
 *
 * A profile's `skills` references do not load or unload anything. Pi loads
 * every installed skill; `/skill:name` stays available to the user for all
 * of them. What the profile controls is what the MODEL sees: the
 * `<available_skills>` section of the system prompt.
 *
 * The filter recomputes that section with Pi's own exported formatter over
 * the profile's selection and replaces it inside the chained system prompt.
 * Because the original section was produced by the same formatter from the
 * same skill array (`BuildSystemPromptOptions.skills`), the recomputation is
 * byte-identical; when it is not found the turn proceeds unfiltered and the
 * caller reports a warning.
 */

import { formatSkillsForPrompt, type BuildSystemPromptOptions, type Skill } from "@earendil-works/pi-coding-agent";

import { matchesReference } from "./name-matching.ts";
import type { SkillsFilter } from "./profile-resolver.ts";

export type SkillsFilterOutcome =
	/** The prompt's skills section was replaced with the filtered one. */
	| "filtered"
	/** No filter applies (default profile without an overlay). */
	| "no-filter"
	/** Neither `read` nor `bash` is active, so Pi emitted no skills section. */
	| "no-read-tool"
	/** The expected section is absent from the prompt; left unfiltered. */
	| "section-missing";

/** The skills the model may see. `undefined` means "no filtering". */
export function visibleSkills(skills: Skill[], filter: SkillsFilter | undefined): Skill[] | undefined {
	if (filter === undefined) return undefined;
	const visible = new Set(visibleSkillNames(skills, filter) ?? []);
	return skills.filter((skill) => visible.has(skill.name));
}

/** The visible skill names, for status reporting and prompt filtering.
 *  `undefined` means "no filtering". */
export function visibleSkillNames(
	all: Array<{ name: string }>,
	filter: SkillsFilter | undefined,
): string[] | undefined {
	if (filter === undefined) return undefined;
	const refs = filter.refs;
	const base = refs === "all" ? all : all.filter((skill) => refs.some((ref) => matchesReference(ref, skill.name)));
	return base
		.filter((skill) => !filter.disabled.some((ref) => matchesReference(ref, skill.name)))
		.map((skill) => skill.name);
}

/** Replaces the system prompt's skills section with the filtered one. */
export function applySkillsFilter(input: {
	systemPrompt: string;
	options: BuildSystemPromptOptions;
	filter: SkillsFilter | undefined;
}): { systemPrompt: string; outcome: SkillsFilterOutcome } {
	const { systemPrompt, options, filter } = input;
	if (filter === undefined) {
		return { systemPrompt, outcome: "no-filter" };
	}
	// Pi emits the section only when a skill-reading tool is active; without
	// one there is nothing to replace.
	const fileReadTool = (["read", "bash"] as const).find((tool) => options.selectedTools?.includes(tool));
	if (fileReadTool === undefined) {
		return { systemPrompt, outcome: "no-read-tool" };
	}
	const all = options.skills ?? [];
	const original = formatSkillsForPrompt(all, fileReadTool);
	if (original.length === 0 || !systemPrompt.includes(original)) {
		return { systemPrompt, outcome: "section-missing" };
	}
	const filtered = formatSkillsForPrompt(visibleSkills(all, filter) ?? [], fileReadTool);
	return { systemPrompt: systemPrompt.replace(original, filtered), outcome: "filtered" };
}

/** The per-profile instructions block appended after the (filtered) prompt. */
export function formatInstructionsBlock(profile: string, instructions: string): string {
	return `\n\n<profile_instructions name="${profile}">\n${instructions}\n</profile_instructions>`;
}
