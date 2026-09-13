import { describe, expect, it } from "vitest";

import type { ResolvedProfile } from "../src/profile-catalog.ts";
import { suggestNames } from "../src/name-matching.ts";
import {
	SelectionError,
	formatSelectionWarnings,
	resolveSelection,
	type LiveResources,
} from "../src/profile-resolver.ts";
import type { RuntimeOverlay } from "../src/runtime-state-store.ts";

function live(overrides: Partial<LiveResources> = {}): LiveResources {
	return {
		skills: [
			{ name: "git-commit", filePath: "/skills/git-commit/SKILL.md" },
			{ name: "code-review", filePath: "/skills/code-review/SKILL.md" },
		],
		toolNames: ["read", "bash", "grep"],
		mcp: { adapterPresent: true, servers: ["atlassian", "github"] },
		...overrides,
	};
}

function profile(definition: ResolvedProfile["definition"], name = "review"): ResolvedProfile {
	return { name, source: "global", definition };
}

describe("resolveSelection: skills", () => {
	it("produces no filter when the profile declares no skills", () => {
		const selection = resolveSelection({ profile: profile({ tools: ["read"] }), live: live() });

		expect(selection.skills).toBeUndefined();
	});

	it("keeps the declared references as a live filter (literals and globs)", () => {
		const selection = resolveSelection({
			profile: profile({ skills: ["git-commit", "code-*"] }),
			live: live(),
		});

		expect(selection.skills).toEqual({ refs: ["git-commit", "code-*"], disabled: [] });
		expect(selection.warnings.skillsUnresolved).toEqual([]);
		expect(selection.warnings.skillsUnmatched).toEqual([]);
	});

	it("treats an explicitly empty skills list as 'nothing visible'", () => {
		const selection = resolveSelection({ profile: profile({ skills: [] }), live: live() });

		expect(selection.skills).toEqual({ refs: [], disabled: [] });
	});

	it("warns with did-you-mean for a literal that matches no loaded skill", () => {
		const selection = resolveSelection({ profile: profile({ skills: ["git-comit"] }), live: live() });

		expect(selection.warnings.skillsUnresolved).toEqual([
			{ reference: "git-comit", suggestions: ["git-commit"] },
		]);
		const lines = formatSelectionWarnings(selection);
		expect(lines.join("\n")).toMatch(/did you mean: "git-commit"/);
	});

	it("collects zero-match globs as unmatched without blocking", () => {
		const selection = resolveSelection({ profile: profile({ skills: ["zzz-*"] }), live: live() });

		expect(selection.warnings.skillsUnmatched).toEqual(["zzz-*"]);
		expect(selection.skills).toEqual({ refs: ["zzz-*"], disabled: [] });
	});

	it("keeps the filter and skips existence warnings when the live set is unknown", () => {
		const selection = resolveSelection({
			profile: profile({ skills: ["git-commit", "ghost-skill", "zzz-*"] }),
			live: live({ skills: undefined }),
		});

		expect(selection.skills).toEqual({ refs: ["git-commit", "ghost-skill", "zzz-*"], disabled: [] });
		expect(selection.warnings.skillsUnresolved).toEqual([]);
		expect(selection.warnings.skillsUnmatched).toEqual([]);
	});

	it("hides overlay-disabled skills from an undeclared profile too", () => {
		const overlay: RuntimeOverlay = { disabledSkills: ["code-review"] };

		const selection = resolveSelection({ profile: profile({}), overlay, live: live() });

		expect(selection.skills).toEqual({ refs: "all", disabled: ["code-review"] });
	});
});

describe("resolveSelection: mcps", () => {
	it("resolves declared literal and glob server names", () => {
		const selection = resolveSelection({
			profile: profile({ mcps: ["atlassian", "git*"] }),
			live: live(),
		});

		expect(selection.mcp).toEqual(["atlassian", "github"]);
	});

	it("fails the activation when the adapter is not active", () => {
		expect(() =>
			resolveSelection({
				profile: profile({ mcps: ["atlassian"] }),
				live: live({ mcp: { adapterPresent: false, servers: [] } }),
			}),
		).toThrow(SelectionError);
	});

	it("fails the activation for a literal server the adapter does not know", () => {
		expect(() =>
			resolveSelection({ profile: profile({ mcps: ["ghost"] }), live: live() }),
		).toThrow(/unknown MCP server "ghost" — adapter discovered: \[atlassian, github\]/);
	});

	it("publishes no allowlist when mcp is undeclared and no overlay narrows it", () => {
		const selection = resolveSelection({ profile: profile({}), live: live() });

		expect(selection.mcp).toBeUndefined();
	});

	it("publishes discovered-minus-disabled when only the overlay narrows", () => {
		const selection = resolveSelection({
			profile: profile({}),
			overlay: { disabledMcp: ["atlassian"] },
			live: live(),
		});

		expect(selection.mcp).toEqual(["github"]);
	});

	it("applies the overlay narrowing to declared servers as well", () => {
		const selection = resolveSelection({
			profile: profile({ mcps: ["atlassian", "github"] }),
			overlay: { disabledMcp: ["atlassian"] },
			live: live(),
		});

		expect(selection.mcp).toEqual(["github"]);
	});

	it("records zero-match mcp globs as unmatched", () => {
		const selection = resolveSelection({ profile: profile({ mcps: ["zzz-*"] }), live: live() });

		expect(selection.mcp).toEqual([]);
		expect(selection.warnings.mcpUnmatched).toEqual(["zzz-*"]);
	});
});

describe("resolveSelection: tools", () => {
	it("resolves literals and globs against the live registry", () => {
		const selection = resolveSelection({ profile: profile({ tools: ["read", "gr*"] }), live: live() });

		expect(selection.tools).toEqual(["read", "grep"]);
		expect(selection.pendingTools).toEqual([]);
	});

	it("keeps an unknown literal pending and retries it instead of dropping it", () => {
		const selection = resolveSelection({ profile: profile({ tools: ["read", "mcp_tool"] }), live: live() });

		expect(selection.tools).toEqual(["read", "mcp_tool"]);
		expect(selection.pendingTools).toEqual(["mcp_tool"]);
		expect(formatSelectionWarnings(selection).join("\n")).toMatch(/not registered yet/);
	});

	it("records zero-match tool globs as unmatched", () => {
		const selection = resolveSelection({ profile: profile({ tools: ["zzz*"] }), live: live() });

		expect(selection.warnings.toolsUnmatched).toEqual(["zzz*"]);
	});

	it("lets the overlay replace the profile's tool references", () => {
		const selection = resolveSelection({
			profile: profile({ tools: ["read"] }),
			overlay: { tools: ["read", "bash"] },
			live: live(),
		});

		expect(selection.tools).toEqual(["read", "bash"]);
	});

	it("leaves Pi's active tool set untouched when tools are undeclared", () => {
		const selection = resolveSelection({ profile: profile({}), live: live() });

		expect(selection.tools).toBeUndefined();
	});

	it("drops the tool selection entirely when the CLI declares tools", () => {
		const selection = resolveSelection({
			profile: profile({ tools: ["read", "gr*"] }),
			live: live(),
			suppressTools: true,
		});

		expect(selection.tools).toBeUndefined();
		expect(selection.pendingTools).toEqual([]);
		expect(selection.warnings.toolsUnmatched).toEqual([]);
	});
});

describe("resolveSelection: model and instructions", () => {
	it("passes a declared model and instructions through unchanged", () => {
		const selection = resolveSelection({
			profile: profile({
				model: { provider: "openai", id: "gpt-5.4", thinkingLevel: "high" },
				instructions: "Review only.",
			}),
			live: live(),
		});

		expect(selection.model).toEqual({ provider: "openai", id: "gpt-5.4", thinkingLevel: "high" });
		expect(selection.instructions).toBe("Review only.");
	});

	it("omits an empty instructions string", () => {
		const selection = resolveSelection({ profile: profile({ instructions: "" }), live: live() });

		expect(selection.instructions).toBeUndefined();
	});
});

describe("suggestNames", () => {
	it("keeps prefix matches and caps the list at three", () => {
		const suggestions = suggestNames("code", ["code-review", "code-audit", "code-format", "unrelated"]);

		expect(suggestions).toHaveLength(3);
		expect(new Set(suggestions)).toEqual(new Set(["code-review", "code-audit", "code-format"]));
	});

	it("finds a near-miss by edit distance", () => {
		expect(suggestNames("git-comit", ["git-commit", "totally-different"])).toContain("git-commit");
	});

	it("returns nothing for a clearly unrelated reference", () => {
		expect(suggestNames("zzzzz", ["git-commit", "code-review"])).toEqual([]);
	});
});
