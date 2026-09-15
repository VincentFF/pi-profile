import { describe, expect, it } from "vitest";

import {
	runProfileCreateWizard,
	runProfileDuplicateWizard,
	runProfileEditWizard,
	type ProfileWizardUi,
} from "../src/switching/profile-wizard.ts";

function scriptedUi(script: {
	selects?: Array<string | undefined>;
	inputs?: Array<string | undefined>;
}): ProfileWizardUi & { selectCalls: string[][] } {
	const selects = [...(script.selects ?? [])];
	const inputs = [...(script.inputs ?? [])];
	const selectCalls: string[][] = [];
	return {
		selectCalls,
		select: async (_title, options) => {
			selectCalls.push(options);
			return selects.shift();
		},
		input: async () => inputs.shift(),
	};
}

describe("runProfileCreateWizard", () => {
	it("captures scope, name, and a full self-contained definition", async () => {
		const ui = scriptedUi({
			selects: ["project"],
			inputs: [
				"review-strict", // name
				"Strict review", // label
				"", // description
				"review, debug-*", // skills
				"linter", // extensions
				"github", // mcps
				"read, grep", // tools
				"Be terse.", // instructions
				"deepseek/deepseek-v4-pro/high", // model
			],
		});

		const result = await runProfileCreateWizard(ui, { projectTrusted: true });

		expect(result).toEqual({
			scope: "project",
			name: "review-strict",
			definition: {
				label: "Strict review",
				skills: ["review", "debug-*"],
				extensions: ["linter"],
				mcps: ["github"],
				tools: ["read", "grep"],
				instructions: "Be terse.",
				defaultProvider: "deepseek",
				defaultModel: "deepseek-v4-pro",
				defaultThinkingLevel: "high",
			},
		});
	});

	it("hides the project scope when untrusted; empty answers omit fields", async () => {
		const ui = scriptedUi({ inputs: ["p", "", "", "", "", "", "", "", ""] });

		const result = await runProfileCreateWizard(ui, { projectTrusted: false });

		// Untrusted: no scope dialog at all — global is the only option.
		expect(ui.selectCalls).toHaveLength(0);
		expect(result).toEqual({ scope: "global", name: "p", definition: {} });
	});

	it("any cancelled step aborts with nothing", async () => {
		expect(await runProfileCreateWizard(scriptedUi({ selects: [undefined] }), { projectTrusted: true })).toBeUndefined();
		expect(
			await runProfileCreateWizard(scriptedUi({ selects: ["global"], inputs: [undefined] }), {
				projectTrusted: true,
			}),
		).toBeUndefined();
	});
});

describe("runProfileEditWizard", () => {
	it("empty answers keep the existing values; fixed name and scope", async () => {
		const ui = scriptedUi({ inputs: ["", "", "", "", "", "", "", ""] });

		const result = await runProfileEditWizard(ui, {
			existing: {
				name: "review",
				source: "global",
				definition: {
					label: "Code review",
					skills: ["review"],
					instructions: "Be terse.",
					defaultProvider: "deepseek",
					defaultModel: "deepseek-v4-pro",
				},
			},
		});

		expect(result).toEqual({
			scope: "global",
			name: "review",
			definition: {
				label: "Code review",
				skills: ["review"],
				instructions: "Be terse.",
				defaultProvider: "deepseek",
				defaultModel: "deepseek-v4-pro",
			},
		});
	});

	it("new answers replace fields wholesale", async () => {
		const ui = scriptedUi({ inputs: ["New label", "", "a, b", "", "", "", "", "openai/gpt-5"] });

		const result = await runProfileEditWizard(ui, {
			existing: { name: "review", source: "project", definition: { skills: ["old"] } },
		});

		expect(result?.definition.label).toBe("New label");
		expect(result?.definition.skills).toEqual(["a", "b"]);
		expect(result?.definition.defaultProvider).toBe("openai");
		expect(result?.definition.defaultModel).toBe("gpt-5");
	});
});

describe("runProfileDuplicateWizard", () => {
	it("picks a source and a new name", async () => {
		const ui = scriptedUi({ selects: ["review [global] — Code review"], inputs: ["review-strict"] });

		const result = await runProfileDuplicateWizard(ui, {
			candidates: [
				{ name: "review", source: "global", definition: { label: "Code review" } },
				{ name: "proj", source: "project", definition: {} },
			],
		});

		expect(result).toEqual({ scope: "global", sourceName: "review", newName: "review-strict" });
	});
});
