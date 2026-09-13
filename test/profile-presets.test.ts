/**
 * The shipped presets are resource-free by construction, and the create wizard
 * copies one without inventing or dropping fields. Each rule here guards a
 * specific activation failure a preset must never cause (see
 * src/profile-presets.ts for the reasoning).
 */

import Ajv2020Module from "ajv/dist/2020.js";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { PROFILE_PRESETS } from "../src/profile-presets.ts";
import { runProfileCreateWizard, type ProfileWizardUi } from "../src/switching/profile-wizard.ts";

const Ajv2020 = Ajv2020Module.default;

/** Pi's own tools. Anything else could be an extension or MCP tool name that
 *  never registers in a given session. */
const BUILTIN_TOOLS = ["read", "grep", "find", "ls", "bash", "edit", "write"];

/** An instruction longer than this stops being a contract and starts costing
 *  adherence on every single turn. */
const MAX_INSTRUCTION_LINES = 8;

function presetCatalog(): Record<string, unknown> {
	return {
		schemaVersion: 1,
		profiles: Object.fromEntries(PROFILE_PRESETS.map((preset) => [preset.name, preset.definition])),
	};
}

describe("profile presets", () => {
	it("declares catalog-safe, unique names", () => {
		expect(PROFILE_PRESETS.length).toBeGreaterThan(0);
		const names = PROFILE_PRESETS.map((preset) => preset.name);
		expect(new Set(names).size).toBe(names.length);
		for (const name of names) {
			expect(name).toMatch(/^[a-z0-9][a-z0-9-]*$/);
			expect(name).not.toBe("default");
		}
	});

	it("assumes no installed skills, MCP servers, or credentials", () => {
		for (const preset of PROFILE_PRESETS) {
			expect(preset.definition.skills, preset.name).toBeUndefined();
			expect(preset.definition.mcp, preset.name).toBeUndefined();
			expect(preset.definition.model, preset.name).toBeUndefined();
			expect(Object.keys(preset.definition as Record<string, unknown>)).not.toContain("extensions");
		}
	});

	it("selects built-in tools and keeps the prompt's skills section alive", () => {
		for (const preset of PROFILE_PRESETS) {
			const tools = preset.definition.tools ?? [];
			expect(tools.length, preset.name).toBeGreaterThan(0);
			for (const tool of tools) {
				expect(BUILTIN_TOOLS, `${preset.name}: ${tool}`).toContain(tool);
			}
			// Pi emits <available_skills> only while read or bash is active.
			expect(tools.some((tool) => tool === "read" || tool === "bash"), preset.name).toBe(true);
		}
	});

	it("carries a short behavior contract instead of a personality", () => {
		for (const preset of PROFILE_PRESETS) {
			const instructions = preset.definition.instructions;
			expect(typeof instructions, preset.name).toBe("string");
			const lines = (instructions ?? "").split("\n");
			expect(lines.length, preset.name).toBeLessThanOrEqual(MAX_INSTRUCTION_LINES);
			for (const line of lines) {
				expect(line.trim().length, `${preset.name}: ${line}`).toBeGreaterThan(0);
				expect(line.length, `${preset.name}: ${line}`).toBeLessThanOrEqual(100);
			}
			expect(preset.definition.label?.trim().length ?? 0, preset.name).toBeGreaterThan(0);
			expect(preset.definition.description?.trim().length ?? 0, preset.name).toBeGreaterThan(0);
		}
	});

	it("produces a catalog the shipped schema accepts", async () => {
		const validate = new Ajv2020({ strict: true }).compile(
			JSON.parse(await readFile(path.resolve("schemas", "profiles.schema.json"), "utf8")),
		);

		expect(validate(presetCatalog()), JSON.stringify(validate.errors)).toBe(true);
	});

	it("is exactly the published examples/profiles.json", async () => {
		const published = JSON.parse(await readFile(path.resolve("examples", "profiles.json"), "utf8"));

		expect(published).toEqual(presetCatalog());
	});
});

/** Scripted wizard UI: one queue per question kind, recording every prompt. */
function scriptedUi(answers: { selects?: string[]; inputs?: string[] }): ProfileWizardUi & { prompts: string[] } {
	const selects = [...(answers.selects ?? [])];
	const inputs = [...(answers.inputs ?? [])];
	const prompts: string[] = [];
	return {
		prompts,
		select: async (title) => {
			prompts.push(title);
			return selects.shift();
		},
		input: async (title) => {
			prompts.push(title);
			return inputs.shift() ?? "";
		},
	};
}

const preset = PROFILE_PRESETS[0];
const presetRow = `${preset.name} — ${preset.definition.description}`;
/** label, description, skills, mcp, tools, instructions, model. */
const KEEP = ["", "", "", "", "", "", ""];

describe("create wizard presets", () => {
	it("copies the preset verbatim when every field answer is empty", async () => {
		const ui = scriptedUi({ selects: [presetRow], inputs: ["", ...KEEP] });

		const result = await runProfileCreateWizard(ui, { projectTrusted: false });

		expect(result).toEqual({
			scope: "global",
			name: preset.name,
			definition: preset.definition,
			preset: preset.name,
		});
	});

	it("leaves a blank start empty and still requires a name", async () => {
		const ui = scriptedUi({ selects: ["blank — start from an empty definition"], inputs: ["my-profile", ...KEEP] });

		const result = await runProfileCreateWizard(ui, { projectTrusted: false });

		expect(result).toEqual({ scope: "global", name: "my-profile", definition: {} });
		expect(await runProfileCreateWizard(scriptedUi({ selects: ["blank — start from an empty definition"] }), {
			projectTrusted: false,
		})).toBeUndefined();
	});

	it("writes nothing when the preset step is cancelled", async () => {
		const ui = scriptedUi({});

		expect(await runProfileCreateWizard(ui, { projectTrusted: false })).toBeUndefined();
		expect(ui.prompts).toEqual(["start from which preset?"]);
	});

	it("keeps user answers over the preset's prefilled fields", async () => {
		const ui = scriptedUi({
			selects: [presetRow],
			inputs: ["audit", "", "", "", "", "read, edit", "Only audit.", ""],
		});

		const result = await runProfileCreateWizard(ui, { projectTrusted: false });

		expect(result?.name).toBe("audit");
		expect(result?.definition.tools).toEqual(["read", "edit"]);
		expect(result?.definition.instructions).toBe("Only audit.");
		expect(result?.definition.skills).toBeUndefined();
	});

	it("skips the preset step when no presets are offered", async () => {
		const ui = scriptedUi({ inputs: ["plain", ...KEEP] });

		const result = await runProfileCreateWizard(ui, { projectTrusted: false, presets: [] });

		expect(result?.name).toBe("plain");
		expect(ui.prompts).not.toContain("start from which preset?");
	});
});
