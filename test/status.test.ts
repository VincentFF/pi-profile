import { describe, expect, it } from "vitest";

import { buildStatusReport, formatStatusMarkdown } from "../src/switching/status.ts";
import { selection } from "./helpers/fake-apply.ts";

const allSkills = [
	{ name: "git-commit", filePath: "/skills/git-commit/SKILL.md" },
	{ name: "code-review", filePath: "/skills/code-review/SKILL.md" },
];

describe("buildStatusReport", () => {
	it("reports every loaded skill as visible without a filter", () => {
		const report = buildStatusReport({
			selection: selection({ mcp: ["atlassian"] }),
			allSkills,
			discoveredMcpServers: ["atlassian", "github"],
		});

		expect(report.profile).toBe("review");
		expect(report.skills.filtered).toBe(false);
		expect(report.skills.visible.map((skill) => skill.name)).toEqual(["git-commit", "code-review"]);
		expect(report.skills.loaded).toBe(2);
		expect(report.mcp).toEqual({ enabled: ["atlassian"], discovered: ["atlassian", "github"], missing: [] });
	});

	it("reports the filtered visible set and the loaded total", () => {
		const report = buildStatusReport({
			selection: selection({ skills: { refs: ["code-*"], disabled: [] } }),
			allSkills,
			discoveredMcpServers: [],
		});

		expect(report.skills.filtered).toBe(true);
		expect(report.skills.visible.map((skill) => skill.name)).toEqual(["code-review"]);
		expect(report.skills.loaded).toBe(2);
	});

	it("reports pending tools and unresolved references", () => {
		const report = buildStatusReport({
			selection: selection({
				tools: ["read", "mcp_tool"],
				pendingTools: ["mcp_tool"],
				warnings: {
					skillsUnresolved: [{ reference: "git-comit", suggestions: ["git-commit"] }],
					skillsUnmatched: ["zzz-*"],
					mcpUnmatched: [],
					toolsUnmatched: [],
				},
			}),
			allSkills,
			discoveredMcpServers: [],
		});

		expect(report.tools).toEqual({ active: ["read", "mcp_tool"], pending: ["mcp_tool"] });
		expect(report.unresolved.skills).toEqual([{ reference: "git-comit", suggestions: ["git-commit"] }]);
		expect(report.unresolved.unmatched).toEqual(["zzz-*"]);
	});

	it("reports declared servers the adapter does not discover", () => {
		const report = buildStatusReport({
			selection: selection({ mcp: ["atlassian", "ghost"] }),
			allSkills,
			discoveredMcpServers: ["atlassian"],
		});

		expect(report.mcp.missing).toEqual(["ghost"]);
	});

	it("carries the last prompt-filter outcome", () => {
		const report = buildStatusReport({
			selection: selection({ skills: { refs: ["code-*"], disabled: [] } }),
			allSkills,
			discoveredMcpServers: [],
			filterOutcome: "section-missing",
		});

		expect(report.skills.filterOutcome).toBe("section-missing");
		expect(formatStatusMarkdown(report)).toContain("skills filter: not applied (section-missing)");
	});
});

describe("formatStatusMarkdown", () => {
	it("renders the profile, skills scope, tools, mcp, and warnings", () => {
		const report = buildStatusReport({
			selection: selection({
				skills: { refs: ["code-*"], disabled: ["git-commit"] },
				tools: ["read"],
				pendingTools: ["mcp_tool"],
				mcp: ["github"],
				warnings: {
					skillsUnresolved: [{ reference: "ghost-skill", suggestions: [] }],
					skillsUnmatched: [],
					mcpUnmatched: [],
					toolsUnmatched: ["zzz*"],
				},
			}),
			allSkills,
			discoveredMcpServers: ["github"],
		});

		const text = formatStatusMarkdown(report);

		expect(text).toContain("### profile: review (global)");
		expect(text).toContain("skills: 1 of 2 loaded");
		expect(text).toContain("code-review → /skills/code-review/SKILL.md");
		expect(text).toContain("tools: [read]");
		expect(text).toContain("tools pending (not registered yet): [mcp_tool]");
		expect(text).toContain("mcp: enabled=[github] discovered=[github] missing=[]");
		expect(text).toContain("unresolved skill: ghost-skill");
		expect(text).toContain("zero-match globs: [zzz*]");
	});

	it("renders the overlay when present", () => {
		const report = {
			...buildStatusReport({ selection: selection(), allSkills, discoveredMcpServers: [] }),
			overlay: { disabledSkills: ["git-commit"], tools: ["read"] },
		};

		expect(formatStatusMarkdown(report)).toContain("overlay: -skill:git-commit tools=[read]");
	});
});
