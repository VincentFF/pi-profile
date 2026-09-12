import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ResolvedProfile } from "../src/profile-catalog.ts";
import { ActivationError, resolveProfile } from "../src/profile-resolver.ts";
import { ResourceRegistry } from "../src/resource-registry.ts";
import type { SkillEntry } from "../src/skill-registry.ts";
import { createPiFixture, type PiFixture } from "./helpers/pi-fixture.ts";

let fixture: PiFixture;

beforeEach(async () => {
	fixture = await createPiFixture();
});

afterEach(async () => {
	await rm(fixture.root, { recursive: true, force: true });
});

function skill(name: string): SkillEntry {
	return {
		name,
		filePath: path.join(fixture.agentDir, "skills", name, "SKILL.md"),
		source: "auto",
		scope: "user",
		origin: "top-level",
	};
}

function profile(name: string, definition: ResolvedProfile["definition"]): ResolvedProfile {
	return { name, source: "global", definition };
}

async function registryWith(entries: Record<string, { dependsOn?: string[]; alwaysOn?: boolean }>): Promise<ResourceRegistry> {
	const extensionsDir = path.join(fixture.agentDir, "extensions");
	await mkdir(extensionsDir, { recursive: true });
	const resources: Record<string, unknown> = {};
	for (const [id, extra] of Object.entries(entries)) {
		const entry = path.join(extensionsDir, `${id}.ts`);
		await writeFile(entry, "export default function () {}\n");
		resources[id] = { kind: "extension", entry, ...extra };
	}
	await writeFile(
		path.join(fixture.agentDir, "resources.json"),
		JSON.stringify({ schemaVersion: 1, resources }),
	);
	return ResourceRegistry.load(fixture.agentDir);
}

describe("resolveProfile", () => {
	it("expands literal and glob skill references against the registry, deduped", async () => {
		const skills = [skill("code-review"), skill("git-commit"), skill("research-web"), skill("research-docs")];

		const plan = await resolveProfile({
			profile: profile("review", { skills: ["code-review", "research-*", "git-commit"] }),
			skills,
			resources: await registryWith({}),
		});

		expect(plan.skills.map((entry) => entry.name).sort()).toEqual([
			"code-review",
			"git-commit",
			"research-docs",
			"research-web",
		]);
	});

	it("fails activation when a literal skill name does not exist", async () => {
		await expect(
			resolveProfile({
				profile: profile("review", { skills: ["no-such-skill"] }),
				skills: [skill("code-review")],
				resources: await registryWith({}),
			}),
		).rejects.toThrow(/no-such-skill/);
	});

	it("treats a glob with no current matches as empty, not an error", async () => {
		const plan = await resolveProfile({
			profile: profile("review", { skills: ["future-*"] }),
			skills: [skill("code-review")],
			resources: await registryWith({}),
		});

		expect(plan.skills).toEqual([]);
	});

	it("joins the dependsOn closure and alwaysOn resources into the extension plan", async () => {
		const resources = await registryWith({
			"review-guard": { dependsOn: ["audit-log"] },
			"audit-log": {},
			"security-gate": { alwaysOn: true },
			unrelated: {},
		});

		const plan = await resolveProfile({
			profile: profile("review", { extensions: ["review-guard"] }),
			skills: [],
			resources,
		});

		expect(plan.extensions.map((entry) => entry.id).sort()).toEqual(["audit-log", "review-guard", "security-gate"]);
	});

	it("expands extension globs against registry IDs", async () => {
		const resources = await registryWith({ "github-pr": {}, "github-ci": {}, other: {} });

		const plan = await resolveProfile({
			profile: profile("review", { extensions: ["github-*"] }),
			skills: [],
			resources,
		});

		expect(plan.extensions.map((entry) => entry.id).sort()).toEqual(["github-ci", "github-pr"]);
	});

	it("fails activation when a literal extension ID is not registered", async () => {
		await expect(
			resolveProfile({
				profile: profile("review", { extensions: ["ghost"] }),
				skills: [],
				resources: await registryWith({}),
			}),
		).rejects.toThrow(/ghost/);
	});

	it("propagates dependency closure failures (cycles, missing entries)", async () => {
		const resources = await registryWith({ a: { dependsOn: ["b"] }, b: { dependsOn: ["a"] } });

		await expect(
			resolveProfile({ profile: profile("review", { extensions: ["a"] }), skills: [], resources }),
		).rejects.toThrow(/cycle/i);
	});

	it("passes literal tool names through and expands tool globs against Pi's built-in tools", async () => {
		const plan = await resolveProfile({
			profile: profile("review", { tools: ["read", "search_issues", "gre*"] }),
			skills: [],
			resources: await registryWith({}),
		});

		expect(plan.tools).toEqual(["read", "search_issues", "grep"]);
	});

	it("keeps the raw tool references for extension-side expansion", async () => {
		const plan = await resolveProfile({
			profile: profile("review", { tools: ["read", "mcp__*"] }),
			skills: [],
			resources: await registryWith({}),
		});

		expect(plan.toolReferences).toEqual(["read", "mcp__*"]);
	});

	it("leaves tools, model, and instructions out of the plan when undeclared", async () => {
		const plan = await resolveProfile({
			profile: profile("review", { skills: ["code-review"] }),
			skills: [skill("code-review")],
			resources: await registryWith({}),
		});

		expect(plan.tools).toBeUndefined();
		expect(plan.model).toBeUndefined();
		expect(plan.instructions).toBeUndefined();
	});

	it("carries a declared model after successful validation", async () => {
		const plan = await resolveProfile({
			profile: profile("review", { model: { provider: "openai", id: "gpt-5.4", thinkingLevel: "high" } }),
			skills: [],
			resources: await registryWith({}),
			validateModel: async () => undefined,
		});

		expect(plan.model).toEqual({ provider: "openai", id: "gpt-5.4", thinkingLevel: "high" });
	});

	it("fails activation when the declared model is missing or unauthenticated", async () => {
		await expect(
			resolveProfile({
				profile: profile("review", { model: { provider: "openai", id: "gpt-5.4" } }),
				skills: [],
				resources: await registryWith({}),
				validateModel: async () => "No API key found for \"openai\"",
			}),
		).rejects.toThrow(/No API key found/);
	});

	it("fails activation on an invalid thinking level", async () => {
		await expect(
			resolveProfile({
				profile: profile("review", { model: { provider: "openai", id: "gpt-5.4", thinkingLevel: "extreme" } }),
				skills: [],
				resources: await registryWith({}),
				validateModel: async () => undefined,
			}),
		).rejects.toThrow(/thinkingLevel/);
	});

	it("expands mcp references against the discovered adapter server names", async () => {
		const plan = await resolveProfile({
			profile: profile("review", { mcp: ["github", "internal-*"] }),
			skills: [],
			resources: await registryWith({}),
			discoveredMcpServers: ["github", "internal-docs", "internal-ci", "other"],
		});

		expect(plan.mcp).toEqual(["github", "internal-docs", "internal-ci"]);
	});

	it("fails activation on a literal mcp reference the adapter never discovered", async () => {
		await expect(
			resolveProfile({
				profile: profile("review", { mcp: ["github-ro"] }),
				skills: [],
				resources: await registryWith({}),
				discoveredMcpServers: ["github"],
			}),
		).rejects.toThrow(/unknown MCP server: "github-ro"/);
	});

	it("fails activation when mcp is declared without adapter server discovery", async () => {
		await expect(
			resolveProfile({
				profile: profile("review", { mcp: ["github"] }),
				skills: [],
				resources: await registryWith({}),
			}),
		).rejects.toThrow(/no adapter server discovery/);
	});

	it("carries declared instructions into the plan", async () => {
		const plan = await resolveProfile({
			profile: profile("review", { instructions: "Be picky." }),
			skills: [],
			resources: await registryWith({}),
		});

		expect(plan.instructions).toBe("Be picky.");
	});
});
