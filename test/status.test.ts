import { describe, expect, it } from "vitest";

import { buildStatusReport, formatStatusMarkdown } from "../src/switching/status.ts";

const basePlan = {
	profile: "review",
	source: "global",
	resolved: {
		skills: [
			{ name: "code-review", filePath: "/agent/skills/code-review/SKILL.md" },
			{ name: "debug", filePath: "/agent/skills/debug/SKILL.md" },
		],
		extensions: [{ id: "linter", entry: "/agent/extensions/linter.ts" }],
	},
	tools: ["read", "grep"],
	mcps: ["github"],
};

describe("buildStatusReport", () => {
	it("reports resolved absolute paths, mcp tri-state, and overlay contents", () => {
		const report = buildStatusReport({
			plan: basePlan,
			overlay: { disabledSkills: ["noisy"] },
			tools: [],
			discoveredMcpServers: ["github", "linear"],
			commands: [
				{ name: "skill:code-review", sourceInfo: { path: "/agent/skills/code-review/SKILL.md" } },
				{ name: "skill:debug", sourceInfo: { path: "/agent/skills/debug/SKILL.md" } },
			],
		});

		expect(report.mcp).toEqual({ enabled: ["github"], disabled: ["linear"], missing: [] });
		expect(report.overlay).toEqual({ disabledSkills: ["noisy"] });
		expect(report.conflicts).toEqual([]);
	});

	it("flags plan mcp servers that discovery no longer finds as missing", () => {
		const report = buildStatusReport({ plan: basePlan, discoveredMcpServers: [], commands: [], tools: [] });

		expect(report.mcp.missing).toEqual(["github"]);
	});

	it("reports the glob delta versus the previous activation", () => {
		const report = buildStatusReport({
			plan: {
				...basePlan,
				previousResolved: { skills: ["code-review", "old-skill"], extensions: ["linter"], tools: ["read", "bash"], mcps: [] },
			},
			discoveredMcpServers: ["github"],
			commands: [],
			tools: [],
		});

		expect(report.delta?.added).toContain("skill:debug");
		expect(report.delta?.added).toContain("mcp:github");
		expect(report.delta?.removed).toEqual(["skill:old-skill", "tool:bash"]);
	});

	it("reports same-name conflicts with Pi's actual winner, never blocking", () => {
		const report = buildStatusReport({
			plan: basePlan,
			tools: [],
			discoveredMcpServers: [],
			commands: [
				{ name: "skill:code-review", sourceInfo: { path: "/agent/skills/code-review/SKILL.md" } },
				// A same-named project skill won Pi's first-wins load order.
				{ name: "skill:debug", sourceInfo: { path: "/project/.pi/skills/debug/SKILL.md" } },
			],
		});

		expect(report.conflicts).toEqual([
			{
				name: "skill:debug",
				expectedPath: "/agent/skills/debug/SKILL.md",
				winnerPath: "/project/.pi/skills/debug/SKILL.md",
			},
		]);
	});

	it("flags resolved skills that never registered as not loaded", () => {
		const report = buildStatusReport({ plan: basePlan, discoveredMcpServers: [], commands: [], tools: [] });

		expect(report.conflicts.map((conflict) => conflict.winnerPath)).toEqual(["not loaded", "not loaded"]);
	});

	it("reports tool conflicts only when the winner is neither builtin nor a selected extension", () => {
		const tools = [
			{ name: "read", sourceInfo: { path: "<builtin:read>", source: "builtin" } },
			// An unrelated extension won the name the plan expected from elsewhere.
			{ name: "grep", sourceInfo: { path: "/other/extensions/sneaky.ts", source: "extension" } },
		];
		const report = buildStatusReport({ plan: basePlan, discoveredMcpServers: [], commands: [], tools });

		expect(report.conflicts).toEqual([
			{ name: "skill:code-review", expectedPath: "/agent/skills/code-review/SKILL.md", winnerPath: "not loaded" },
			{ name: "skill:debug", expectedPath: "/agent/skills/debug/SKILL.md", winnerPath: "not loaded" },
			{ name: "tool:grep", expectedPath: "builtin or selected extension", winnerPath: "/other/extensions/sneaky.ts" },
		]);

		// A tool owned by a plan-selected extension is expected, not a conflict.
		const withExtensionTool = buildStatusReport({
			plan: { ...basePlan, tools: ["lint-fix"] },
			discoveredMcpServers: [],
			commands: [],
			tools: [{ name: "lint-fix", sourceInfo: { path: "/agent/extensions/linter.ts", source: "extension" } }],
		});
		expect(withExtensionTool.conflicts.map((conflict) => conflict.name)).toEqual([
			"skill:code-review",
			"skill:debug",
		]);
	});
});

describe("formatStatusMarkdown", () => {
	it("renders all sections readably", () => {
		const report = buildStatusReport({
			plan: basePlan,
			overlay: { tools: ["read"] },
			tools: [],
			discoveredMcpServers: ["github", "linear"],
			commands: [],
		});

		const markdown = formatStatusMarkdown(report);
		expect(markdown).toContain("profile: review (global)");
		expect(markdown).toContain("overlay: tools=[read]");
		expect(markdown).toContain("code-review → /agent/skills/code-review/SKILL.md");
		expect(markdown).toContain("mcp: enabled=[github] disabled=[linear]");
	});
});
