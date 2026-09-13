import { describe, expect, it } from "vitest";

import {
	buildProfileBadge,
	displayWidth,
	PROFILE_BADGE_NAME_COLUMNS,
	renderProfileBadge,
	truncateToColumns,
	type BadgeTheme,
	type ProfileBadge,
} from "../src/profile-badge.ts";

/** Renders text unchanged, so assertions read as plain badge text. */
const plain: BadgeTheme = { fg: (_color, text) => text };
/** Exposes which theme color each part asked for. */
const marked: BadgeTheme = { fg: (color, text) => `<${color}>${text}` };

function badge(name: string, overlay = false, nameColumns?: number): ProfileBadge {
	const result = buildProfileBadge(name, { overlay, ...(nameColumns === undefined ? {} : { nameColumns }) });
	if (result === undefined) throw new Error(`expected a badge for ${JSON.stringify(name)}`);
	return result;
}

describe("buildProfileBadge", () => {
	it("has no badge for the default profile — it must not change the footer", () => {
		expect(buildProfileBadge("default", { overlay: false })).toBeUndefined();
		// Even an overlay on default (impossible via the commands, possible in
		// a hand-written state file) must not resurrect the badge.
		expect(buildProfileBadge("default", { overlay: true })).toBeUndefined();
	});

	it("carries the profile name and the overlay marker", () => {
		expect(badge("review")).toEqual({ name: "review", overlay: false });
		expect(badge("review", true)).toEqual({ name: "review", overlay: true });
	});
});

describe("renderProfileBadge", () => {
	it("renders the canonical `profile: <name>` shape", () => {
		expect(renderProfileBadge(badge("review"), plain)).toBe("profile: review");
	});

	it("marks a runtime overlay with a star", () => {
		expect(renderProfileBadge(badge("review", true), plain)).toBe("profile: review*");
	});

	it("asks the theme for the colors at render time", () => {
		expect(renderProfileBadge(badge("review", true), marked)).toBe(
			"<dim>profile: <dim>review<warning>*",
		);
	});
});

describe("displayWidth", () => {
	it("counts narrow characters as one column", () => {
		expect(displayWidth("")).toBe(0);
		expect(displayWidth("review")).toBe(6);
	});

	it("counts East Asian wide characters as two columns", () => {
		expect(displayWidth("评审")).toBe(4);
		expect(displayWidth("ａｂ")).toBe(4); // fullwidth forms
		expect(displayWidth("re评审")).toBe(6);
	});
});

describe("truncateToColumns", () => {
	it("keeps text that fits untouched", () => {
		expect(truncateToColumns("review", 16)).toBe("review");
		expect(truncateToColumns("评审", 4)).toBe("评审");
	});

	it("elides the overflow inside the budget", () => {
		const long = "a".repeat(40);
		const truncated = truncateToColumns(long, PROFILE_BADGE_NAME_COLUMNS);
		expect(truncated).toBe(`${"a".repeat(PROFILE_BADGE_NAME_COLUMNS - 1)}…`);
		expect(displayWidth(truncated)).toBe(PROFILE_BADGE_NAME_COLUMNS);
	});

	it("respects wide characters when eliding", () => {
		const truncated = truncateToColumns("工作流配置管理工具链", 16);
		expect(truncated).toBe("工作流配置管理…"); // 7 wide chars + ellipsis = 15 columns
		expect(displayWidth(truncated)).toBeLessThanOrEqual(16);
	});

	it("degenerates to nothing when there is no room", () => {
		expect(truncateToColumns("review", 0)).toBe("");
		expect(truncateToColumns("review", -3)).toBe("");
		expect(truncateToColumns("评审", 1)).toBe("…");
	});
});
