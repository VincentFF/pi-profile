import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { detectExplicitDeclarations, resolveStartupProfile, UnknownProfileError } from "../src/startup-selection.ts";
import { createPiFixture, type PiFixture } from "./helpers/pi-fixture.ts";

let fixture: PiFixture;

beforeEach(async () => {
	fixture = await createPiFixture();
});

afterEach(async () => {
	await rm(fixture.root, { recursive: true, force: true });
});

async function writeGlobalCatalog(): Promise<void> {
	await writeFile(
		path.join(fixture.agentDir, "profiles.json"),
		JSON.stringify({ schemaVersion: 1, profiles: { review: { skills: ["git-commit"] } } }),
	);
}

async function writeState(dir: string, content: unknown): Promise<void> {
	await writeFile(path.join(dir, "pi-profile-state.json"), JSON.stringify(content));
}

describe("detectExplicitDeclarations", () => {
	it("reports nothing for a bare invocation", () => {
		expect(detectExplicitDeclarations([])).toEqual({ model: false, thinking: false, tools: false });
	});

	it("detects the --model space form (Pi has no --model=value form)", () => {
		expect(detectExplicitDeclarations(["--model", "openai/gpt-5.4"]).model).toBe(true);
		expect(detectExplicitDeclarations(["--model=openai/gpt-5.4"]).model).toBe(false);
	});

	it("detects --thinking", () => {
		expect(detectExplicitDeclarations(["--thinking", "high"]).thinking).toBe(true);
	});

	it("detects --tools and --exclude-tools as tool declarations", () => {
		expect(detectExplicitDeclarations(["--tools", "read,bash"]).tools).toBe(true);
		expect(detectExplicitDeclarations(["--exclude-tools", "write"]).tools).toBe(true);
	});

	it("ignores the profile flag and unrelated arguments", () => {
		expect(detectExplicitDeclarations(["--profile", "review", "--mode", "rpc"])).toEqual({
			model: false,
			thinking: false,
			tools: false,
		});
	});
});

describe("resolveStartupProfile", () => {
	it("falls back to the built-in default without any saved selection", async () => {
		await writeGlobalCatalog();

		const result = await resolveStartupProfile({ agentDir: fixture.agentDir, cwd: fixture.cwd, projectTrusted: false });

		expect(result.name).toBe("default");
		expect(result.warnings).toEqual([]);
	});

	it("restores the saved global selection", async () => {
		await writeGlobalCatalog();
		await writeState(fixture.agentDir, { activeProfile: "review" });

		const result = await resolveStartupProfile({ agentDir: fixture.agentDir, cwd: fixture.cwd, projectTrusted: false });

		expect(result.name).toBe("review");
	});

	it("prefers the project selection in a trusted project", async () => {
		await writeGlobalCatalog();
		await writeFile(
			path.join(fixture.cwd, ".pi", "profiles.json"),
			JSON.stringify({ schemaVersion: 1, profiles: { local: { skills: [] } } }),
		);
		await writeState(fixture.agentDir, { activeProfile: "review" });
		await writeState(path.join(fixture.cwd, ".pi"), { activeProfile: "local" });

		const result = await resolveStartupProfile({ agentDir: fixture.agentDir, cwd: fixture.cwd, projectTrusted: true });

		expect(result.name).toBe("local");
	});

	it("does not read project state when the project is untrusted", async () => {
		await writeGlobalCatalog();
		await writeState(fixture.agentDir, { activeProfile: "review" });
		await writeState(path.join(fixture.cwd, ".pi"), { activeProfile: "local" });

		const result = await resolveStartupProfile({ agentDir: fixture.agentDir, cwd: fixture.cwd, projectTrusted: false });

		expect(result.name).toBe("review");
	});

	it("lets the explicit flag win over the saved selection", async () => {
		await writeGlobalCatalog();
		await writeState(fixture.agentDir, { activeProfile: "review" });

		const result = await resolveStartupProfile({
			agentDir: fixture.agentDir,
			cwd: fixture.cwd,
			projectTrusted: false,
			requested: "review",
		});

		expect(result.name).toBe("review");
	});

	it("fails loudly for an unknown explicit profile and lists the candidates", async () => {
		await writeGlobalCatalog();

		await expect(
			resolveStartupProfile({
				agentDir: fixture.agentDir,
				cwd: fixture.cwd,
				projectTrusted: false,
				requested: "ghost",
			}),
		).rejects.toThrow(UnknownProfileError);
		await expect(
			resolveStartupProfile({
				agentDir: fixture.agentDir,
				cwd: fixture.cwd,
				projectTrusted: false,
				requested: "ghost",
			}),
		).rejects.toThrow(/available: \[default, review\]/);
	});

	it("falls back to default with a warning when the saved profile no longer exists", async () => {
		await writeGlobalCatalog();
		await writeState(fixture.agentDir, { activeProfile: "removed" });

		const result = await resolveStartupProfile({ agentDir: fixture.agentDir, cwd: fixture.cwd, projectTrusted: false });

		expect(result.name).toBe("default");
		expect(result.warnings.join("\n")).toMatch(/saved profile "removed" no longer exists/);
	});

	it("warns once about a leftover resources.json in the agent dir", async () => {
		await writeGlobalCatalog();
		await writeFile(path.join(fixture.agentDir, "resources.json"), JSON.stringify({ resources: {} }));

		const result = await resolveStartupProfile({ agentDir: fixture.agentDir, cwd: fixture.cwd, projectTrusted: false });

		expect(result.warnings.join("\n")).toMatch(/resources\.json is no longer read/);
	});

	it("does not read an untrusted project's resources.json", async () => {
		await writeGlobalCatalog();
		await writeFile(path.join(fixture.cwd, ".pi", "resources.json"), JSON.stringify({ resources: {} }));

		const result = await resolveStartupProfile({ agentDir: fixture.agentDir, cwd: fixture.cwd, projectTrusted: false });

		expect(result.warnings.join("\n")).not.toMatch(/resources\.json/);
	});
});
