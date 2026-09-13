import {
	createSyntheticSourceInfo,
	formatSkillsForPrompt,
	type BuildSystemPromptOptions,
	type Skill,
} from "@earendil-works/pi-coding-agent";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { applySkillsFilter, formatInstructionsBlock, visibleSkillNames, visibleSkills } from "../src/skill-selection.ts";

function skill(name: string, overrides: Partial<Skill> = {}): Skill {
	const filePath = `/skills/${name}/SKILL.md`;
	return {
		name,
		description: `Skill ${name}`,
		filePath,
		baseDir: path.dirname(filePath),
		sourceInfo: createSyntheticSourceInfo(filePath, { source: "test" }),
		disableModelInvocation: false,
		...overrides,
	};
}

const all = [skill("alpha"), skill("beta"), skill("gamma")];

function options(overrides: Partial<BuildSystemPromptOptions> = {}): BuildSystemPromptOptions {
	return {
		cwd: "/project",
		selectedTools: ["read", "bash", "edit", "write"],
		skills: all,
		...overrides,
	};
}

/** A prompt shaped like Pi's: header, the emitted skills section, cwd line. */
function promptWith(skills: Skill[], fileReadTool: "read" | "bash" = "read"): string {
	return `HEADER${formatSkillsForPrompt(skills, fileReadTool)}\nCurrent working directory: /project`;
}

describe("applySkillsFilter", () => {
	it("replaces the skills section with the filtered one", () => {
		const systemPrompt = promptWith(all);

		const result = applySkillsFilter({
			systemPrompt,
			options: options(),
			filter: { refs: ["alpha"], disabled: [] },
		});

		expect(result.outcome).toBe("filtered");
		expect(result.systemPrompt).toBe(`HEADER${formatSkillsForPrompt([all[0]], "read")}\nCurrent working directory: /project`);
		expect(result.systemPrompt).toContain("alpha");
		expect(result.systemPrompt).not.toContain("beta");
		expect(result.systemPrompt).not.toContain("gamma");
	});

	it("removes the whole section when nothing is selected", () => {
		const systemPrompt = promptWith(all);

		const result = applySkillsFilter({ systemPrompt, options: options(), filter: { refs: [], disabled: [] } });

		expect(result.outcome).toBe("filtered");
		expect(result.systemPrompt).toBe("HEADER\nCurrent working directory: /project");
	});

	it("supports globs and disabled references", () => {
		const systemPrompt = promptWith(all);

		const result = applySkillsFilter({
			systemPrompt,
			options: options(),
			filter: { refs: ["a*", "beta"], disabled: ["beta"] },
		});

		expect(result.systemPrompt).toContain("alpha");
		expect(result.systemPrompt).not.toContain("beta");
	});

	it("uses bash-formatting when bash is the skill-reading tool", () => {
		const systemPrompt = promptWith(all, "bash");

		const result = applySkillsFilter({
			systemPrompt,
			options: options({ selectedTools: ["bash"] }),
			filter: { refs: ["alpha"], disabled: [] },
		});

		expect(result.outcome).toBe("filtered");
		expect(result.systemPrompt).toBe(`HEADER${formatSkillsForPrompt([all[0]], "bash")}\nCurrent working directory: /project`);
	});

	it("leaves the prompt untouched when no filter applies", () => {
		const systemPrompt = promptWith(all);

		const result = applySkillsFilter({ systemPrompt, options: options(), filter: undefined });

		expect(result).toEqual({ systemPrompt, outcome: "no-filter" });
	});

	it("leaves the prompt untouched when neither read nor bash is active", () => {
		const systemPrompt = promptWith(all);

		const result = applySkillsFilter({
			systemPrompt,
			options: options({ selectedTools: ["edit", "write"] }),
			filter: { refs: ["alpha"], disabled: [] },
		});

		expect(result.outcome).toBe("no-read-tool");
		expect(result.systemPrompt).toBe(systemPrompt);
	});

	it("reports a missing section instead of corrupting the prompt", () => {
		const systemPrompt = "HEADER without any skills section";

		const result = applySkillsFilter({
			systemPrompt,
			options: options(),
			filter: { refs: ["alpha"], disabled: [] },
		});

		expect(result.outcome).toBe("section-missing");
		expect(result.systemPrompt).toBe(systemPrompt);
	});

	it("keeps Pi's disable-model-invocation behavior intact", () => {
		const hidden = skill("hidden", { disableModelInvocation: true });
		const withHidden = [...all, hidden];
		const systemPrompt = promptWith(withHidden);

		const result = applySkillsFilter({
			systemPrompt,
			options: options({ skills: withHidden }),
			filter: { refs: [], disabled: [] },
		});

		// The section Pi emitted already excludes hidden skills; filtering to
		// nothing removes it.
		expect(systemPrompt).not.toContain("hidden");
		expect(result.systemPrompt).toBe("HEADER\nCurrent working directory: /project");
	});
});

describe("visibleSkills / visibleSkillNames", () => {
	it("returns undefined when there is no filter", () => {
		expect(visibleSkills(all, undefined)).toBeUndefined();
		expect(visibleSkillNames(all, undefined)).toBeUndefined();
	});

	it("matches literals and globs and applies disabled references", () => {
		expect(visibleSkillNames(all, { refs: ["a*", "gamma"], disabled: ["gamma"] })).toEqual(["alpha"]);
	});

	it("treats refs 'all' as 'everything, minus disabled'", () => {
		expect(visibleSkillNames(all, { refs: "all", disabled: ["beta"] })).toEqual(["alpha", "gamma"]);
	});

	it("treats an empty refs list as 'nothing visible'", () => {
		expect(visibleSkillNames(all, { refs: [], disabled: [] })).toEqual([]);
	});
});

describe("formatInstructionsBlock", () => {
	it("wraps the instructions in a profile-named block", () => {
		expect(formatInstructionsBlock("review", "Review only.")).toBe(
			'\n\n<profile_instructions name="review">\nReview only.\n</profile_instructions>',
		);
	});
});
