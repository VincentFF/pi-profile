import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ResolvedProfile } from "../src/profile-catalog.ts";
import { ActivationError, resolveProfile } from "../src/profile-resolver.ts";
import { DiscoveredExtensions, discoverExtensions } from "../src/extension-discovery.ts";
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

async function extensionsWith(names: string[] = []): Promise<DiscoveredExtensions> {
	const extensionsDir = path.join(fixture.agentDir, "extensions");
	await mkdir(extensionsDir, { recursive: true });
	for (const name of names) {
		const entry = path.join(extensionsDir, `${name}.ts`);
		await writeFile(entry, "export default function () {}\n");
	}
	return discoverExtensions({ agentDir: fixture.agentDir, packages: [] });
}

describe("resolveProfile", () => {
	it("expands literal and glob skill references against the registry, deduped", async () => {
		const skills = [skill("code-review"), skill("git-commit"), skill("research-web"), skill("research-docs")];

		const plan = await resolveProfile({
			profile: profile("review", { skills: ["code-review", "research-*", "git-commit"] }),
			skills,
			extensions: await extensionsWith(),
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
				extensions: await extensionsWith(),
			}),
		).rejects.toThrow(/no-such-skill/);
	});

	it("treats a glob with no current matches as empty, not an error", async () => {
		const plan = await resolveProfile({
			profile: profile("review", { skills: ["future-*"] }),
			skills: [skill("code-review")],
			extensions: await extensionsWith(),
		});

		expect(plan.skills).toEqual([]);
	});

	it("resolves multiple declared extensions directly without dependencies", async () => {
		const extensions = await extensionsWith(["review-guard", "audit-log", "unrelated"]);

		const plan = await resolveProfile({
			profile: profile("review", { extensions: ["review-guard", "audit-log"] }),
			skills: [],
			extensions,
		});

		expect(plan.extensions.map((entry) => entry.id).sort()).toEqual(["audit-log", "review-guard"]);
	});

	it("expands extension globs against discovered extensions", async () => {
		const extensions = await extensionsWith(["github-pr", "github-ci", "other"]);

		const plan = await resolveProfile({
			profile: profile("review", { extensions: ["github-*"] }),
			skills: [],
			extensions,
		});

		expect(plan.extensions.map((entry) => entry.id).sort()).toEqual(["github-ci", "github-pr"]);
	});

	it("fails activation when a literal extension is not discovered", async () => {
		await expect(
			resolveProfile({
				profile: profile("review", { extensions: ["ghost"] }),
				skills: [],
				extensions: await extensionsWith(),
			}),
		).rejects.toThrow(/ghost/);
	});

	it("passes literal tool names through and expands tool globs against Pi's built-in tools", async () => {
		const plan = await resolveProfile({
			profile: profile("review", { tools: ["read", "search_issues", "gre*"] }),
			skills: [],
			extensions: await extensionsWith(),
		});

		expect(plan.tools).toEqual(["read", "search_issues", "grep"]);
	});

	it("keeps the raw tool references for extension-side expansion", async () => {
		const plan = await resolveProfile({
			profile: profile("review", { tools: ["read", "mcp__*"] }),
			skills: [],
			extensions: await extensionsWith(),
		});

		expect(plan.toolReferences).toEqual(["read", "mcp__*"]);
	});

	it("leaves tools, model, and instructions out of the plan when undeclared", async () => {
		const plan = await resolveProfile({
			profile: profile("review", { skills: ["code-review"] }),
			skills: [skill("code-review")],
			extensions: await extensionsWith(),
		});

		expect(plan.tools).toBeUndefined();
		expect(plan.model).toBeUndefined();
		expect(plan.instructions).toBeUndefined();
	});

	it("carries a declared model after successful validation", async () => {
		const plan = await resolveProfile({
			profile: profile("review", { defaultProvider: "openai", defaultModel: "gpt-5.4", defaultThinkingLevel: "high" }),
			skills: [],
			extensions: await extensionsWith(),
			validateModel: async () => undefined,
		});

		expect(plan.model).toEqual({ provider: "openai", id: "gpt-5.4", thinkingLevel: "high" });
	});

	it("fails activation when the declared model is missing or unauthenticated", async () => {
		await expect(
			resolveProfile({
				profile: profile("review", { defaultProvider: "openai", defaultModel: "gpt-5.4" }),
				skills: [],
				extensions: await extensionsWith(),
				validateModel: async () => "No API key found for \"openai\"",
			}),
		).rejects.toThrow(/No API key found/);
	});

	it("fails activation on an invalid thinking level", async () => {
		await expect(
			resolveProfile({
				profile: profile("review", { defaultProvider: "openai", defaultModel: "gpt-5.4", defaultThinkingLevel: "extreme" }),
				skills: [],
				extensions: await extensionsWith(),
				validateModel: async () => undefined,
			}),
		).rejects.toThrow(/thinkingLevel/);
	});

	it("expands mcp references against the discovered adapter server names", async () => {
		const plan = await resolveProfile({
			profile: profile("review", { mcps: ["github", "internal-*"] }),
			skills: [],
			extensions: await extensionsWith(),
			discoveredMcpServers: ["github", "internal-docs", "internal-ci", "other"],
		});

		expect(plan.mcps).toEqual(["github", "internal-docs", "internal-ci"]);
	});

	it("fails activation on a literal mcp reference the adapter never discovered", async () => {
		await expect(
			resolveProfile({
				profile: profile("review", { mcps: ["github-ro"] }),
				skills: [],
				extensions: await extensionsWith(),
				discoveredMcpServers: ["github"],
			}),
		).rejects.toThrow(/unknown MCP server: "github-ro"/);
	});

	it("fails activation when mcp is declared without adapter server discovery", async () => {
		await expect(
			resolveProfile({
				profile: profile("review", { mcps: ["github"] }),
				skills: [],
				extensions: await extensionsWith(),
			}),
		).rejects.toThrow(/no adapter server discovery/);
	});

	it("carries declared instructions into the plan", async () => {
		const plan = await resolveProfile({
			profile: profile("review", { instructions: "Be picky." }),
			skills: [],
			extensions: await extensionsWith(),
		});

		expect(plan.instructions).toBe("Be picky.");
	});
});

describe("overlay application (ticket 06)", () => {
	it("narrows resolved skills by disabledSkills", async () => {
		const plan = await resolveProfile({
			profile: profile("review", { skills: ["code-review", "debug"] }),
			skills: [skill("code-review"), skill("debug")],
			extensions: await extensionsWith(),
			overlay: { disabledSkills: ["debug"] },
		});

		expect(plan.skills.map((entry) => entry.name)).toEqual(["code-review"]);
	});

	it("rejects disabling a skill the profile does not resolve", async () => {
		await expect(
			resolveProfile({
				profile: profile("review", { skills: ["code-review"] }),
				skills: [skill("code-review")],
				extensions: await extensionsWith(),
				overlay: { disabledSkills: ["ghost-skill"] },
			}),
		).rejects.toThrow(/overlay disables unknown skill "ghost-skill"/);
	});

	it("narrows extensions by disabledExtensions", async () => {
		const extensions = await extensionsWith(["linter", "helper"]);

		const plan = await resolveProfile({
			profile: profile("review", { extensions: ["linter", "helper"] }),
			skills: [],
			extensions,
			overlay: { disabledExtensions: ["helper"] },
		});

		expect(plan.extensions.map((entry) => entry.id).sort()).toEqual(["linter"]);
	});

	it("rejects disabling an extension the profile does not resolve", async () => {
		const extensions = await extensionsWith(["linter"]);

		await expect(
			resolveProfile({
				profile: profile("review", { extensions: ["linter"] }),
				skills: [],
				extensions,
				overlay: { disabledExtensions: ["ghost-ext"] },
			}),
		).rejects.toThrow(/overlay disables unknown extension "ghost-ext"/);
	});

	it("narrows mcp servers and replaces tool references", async () => {
		const plan = await resolveProfile({
			profile: profile("review", { mcps: ["github", "linear"], tools: ["read", "bash"] }),
			skills: [],
			extensions: await extensionsWith(),
			discoveredMcpServers: ["github", "linear"],
			overlay: { disabledMcps: ["linear"], tools: ["read"] },
		});

		expect(plan.mcps).toEqual(["github"]);
		expect(plan.tools).toEqual(["read"]);
		expect(plan.toolReferences).toEqual(["read"]);
	});

	it("rejects disabling an MCP server the profile does not resolve", async () => {
		await expect(
			resolveProfile({
				profile: profile("review", { mcps: ["github"] }),
				skills: [],
				extensions: await extensionsWith(),
				discoveredMcpServers: ["github"],
				overlay: { disabledMcps: ["ghost-server"] },
			}),
		).rejects.toThrow(/overlay disables unknown MCP server "ghost-server"/);
	});
});

describe("discovery-first extension references (ADR-0006)", () => {
	async function registryWithPackage(name: string): Promise<{ registry: DiscoveredExtensions; entry: string }> {
		const root = path.join(fixture.agentDir, "npm", "node_modules", name);
		await mkdir(root, { recursive: true });
		const entry = path.join(root, "index.ts");
		await writeFile(entry, "export default function () {}\n");
		await writeFile(path.join(root, "package.json"), JSON.stringify({ name, pi: { extensions: ["./index.ts"] } }));
		const registry = await discoverExtensions({
			agentDir: fixture.agentDir,
			packages: [{ source: `npm:${name}`, root }],
		});
		return { registry, entry };
	}

	it("a profile references an installed package by name, no registration", async () => {
		const { registry, entry } = await registryWithPackage("pi-mcp-adapter");

		const plan = await resolveProfile({
			profile: profile("review", { extensions: ["pi-mcp-adapter"] }),
			skills: [],
			extensions: registry,
		});

		expect(plan.extensions).toEqual([{ id: "pi-mcp-adapter", entry }]);
	});

	it("a profile references an extension by absolute path", async () => {
		const dir = path.join(fixture.agentDir, "extensions");
		await mkdir(dir, { recursive: true });
		const file = path.join(dir, "one-off.ts");
		await writeFile(file, "export default function () {}\n");

		const plan = await resolveProfile({
			profile: profile("review", { extensions: [file] }),
			skills: [],
			extensions: await extensionsWith(),
		});

		expect(plan.extensions).toEqual([{ id: file, entry: file }]);
	});

	it("unknown extension literals fail with actionable guidance", async () => {
		const { registry } = await registryWithPackage("pi-mcp-adapter");

		const error = await resolveProfile({
			profile: profile("review", { extensions: ["mcp-adapter"] }),
			skills: [],
			extensions: registry,
		}).catch((caught: unknown) => caught);

		expect((error as Error).message).toContain('did you mean "pi-mcp-adapter"');
		expect((error as Error).message).not.toContain("resources.json");
	});

	it("zero-match globs land in plan.unmatched instead of failing silently", async () => {
		const plan = await resolveProfile({
			profile: profile("review", { skills: ["future-*"], extensions: ["ghost-*"] }),
			skills: [skill("code-review")],
			extensions: await extensionsWith(),
		});

		expect(plan.skills).toEqual([]);
		expect(plan.extensions).toEqual([]);
		expect(plan.unmatched).toEqual(["skill:future-*", "extension:ghost-*"]);
	});

	it("overlays disable package-selected extensions by their resolved ID", async () => {
		const { registry, entry } = await registryWithPackage("pi-mcp-adapter");

		const plan = await resolveProfile({
			profile: profile("review", { extensions: ["pi-mcp-adapter"] }),
			skills: [],
			extensions: registry,
			overlay: { disabledExtensions: ["pi-mcp-adapter"] },
		});

		expect(plan.extensions).toEqual([]);
		expect(entry).toContain("pi-mcp-adapter");
	});
});
