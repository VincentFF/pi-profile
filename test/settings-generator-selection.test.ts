import { existsSync } from "node:fs";
import { mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { defaultPlan, type ActivationPlan } from "../src/profile-resolver.ts";
import { generateRuntimeDir, writeRuntimeFiles, type DiscoveryContext } from "../src/settings-generator.ts";
import type { SkillEntry } from "../src/skill-registry.ts";
import { addGlobalSkill, createPiFixture, type PiFixture } from "./helpers/pi-fixture.ts";

let fixture: PiFixture;
let savedHome: string | undefined;

beforeEach(async () => {
	fixture = await createPiFixture();
	savedHome = process.env.HOME;
	process.env.HOME = fixture.root;
});

afterEach(async () => {
	process.env.HOME = savedHome;
	await rm(fixture.root, { recursive: true, force: true });
});

function agentDirSkill(name: string): SkillEntry {
	return {
		name,
		filePath: path.join(fixture.agentDir, "skills", name, "SKILL.md"),
		source: "auto",
		scope: "user",
		origin: "top-level",
	};
}

function agentsSkill(name: string): SkillEntry {
	return {
		name,
		filePath: path.join(fixture.root, ".agents", "skills", name, "SKILL.md"),
		source: "auto",
		scope: "user",
		origin: "top-level",
		baseDir: path.join(fixture.root, ".agents"),
	};
}

function packageSkill(name: string, pkg: { source: string; root: string }): SkillEntry {
	return {
		name,
		filePath: path.join(pkg.root, "skills", name, "SKILL.md"),
		source: pkg.source,
		scope: "user",
		origin: "package",
		baseDir: pkg.root,
	};
}

function selectionPlan(overrides: Partial<ActivationPlan>): ActivationPlan {
	return { profile: "review", source: "global", filter: "selection", skills: [], extensions: [], ...overrides };
}

async function generatedSettings(runtimeDir: string): Promise<Record<string, unknown>> {
	return JSON.parse(await readFile(path.join(runtimeDir, "settings.json"), "utf8"));
}

describe("generateRuntimeDir (named profile selection)", () => {
	it("allowlists selected agent dir skills as additive absolute paths", async () => {
		const plan = selectionPlan({ skills: [agentDirSkill("alpha-skill")] });
		const discovery: DiscoveryContext = {
			skills: [agentDirSkill("alpha-skill"), agentDirSkill("beta-skill")],
			packages: [],
		};

		const result = await generateRuntimeDir(plan, { agentDir: fixture.agentDir, discovery });
		const settings = await generatedSettings(result.runtimeDir);

		expect(settings.skills).toEqual([
			path.join(fixture.agentDir, "skills", "alpha-skill", "SKILL.md"),
			`-${path.join(result.runtimeDir, "skills", "beta-skill", "SKILL.md")}`,
		]);
	});

	it("force-excludes agent dir skills that are symlinks to outside the agent dir", async () => {
		// Pi matches `-` exclusions against the raw discovered path without
		// resolving symlinks. The exclusion must therefore name the runtime
		// mirror path, not the symlink target — otherwise it matches nothing
		// and the skill leaks into the session (the agentDir skills of a
		// dotfiles-managed skill library are symlinks in real setups).
		const libraryDir = path.join(fixture.root, "skill-library", "linked-skill");
		await mkdir(libraryDir, { recursive: true });
		await writeFile(path.join(libraryDir, "SKILL.md"), "---\nname: linked-skill\n---\n");
		await mkdir(path.join(fixture.agentDir, "skills"), { recursive: true });
		await symlink(libraryDir, path.join(fixture.agentDir, "skills", "linked-skill"), "dir");

		const plan = selectionPlan({ skills: [] });
		const discovery: DiscoveryContext = { skills: [agentDirSkill("linked-skill")], packages: [] };

		const result = await generateRuntimeDir(plan, { agentDir: fixture.agentDir, discovery });
		const settings = await generatedSettings(result.runtimeDir);

		expect(settings.skills).toEqual([
			`-${path.join(result.runtimeDir, "skills", "linked-skill", "SKILL.md")}`,
		]);
	});

	it("force-excludes unselected ~/.agents skills while keeping selected ones auto-discovered", async () => {
		const plan = selectionPlan({ skills: [agentsSkill("shared-skill")] });
		const discovery: DiscoveryContext = {
			skills: [agentsSkill("shared-skill"), agentsSkill("secret-skill")],
			packages: [],
		};

		const result = await generateRuntimeDir(plan, { agentDir: fixture.agentDir, discovery });
		const settings = await generatedSettings(result.runtimeDir);

		expect(settings.skills).toEqual([
			`-${path.join(fixture.root, ".agents", "skills", "secret-skill", "SKILL.md")}`,
		]);
	});

	it("writes selected extensions as additive entry paths", async () => {
		const plan = selectionPlan({
			extensions: [{ id: "review-guard", entry: "/opt/pi-resources/review-guard/index.ts" }],
		});

		const result = await generateRuntimeDir(plan, { agentDir: fixture.agentDir, discovery: { skills: [], packages: [] } });
		const settings = await generatedSettings(result.runtimeDir);

		expect(settings.extensions).toEqual(["/opt/pi-resources/review-guard/index.ts"]);
	});

	it("filters configured packages down to the selected resources, object form", async () => {
		const pkg = { source: path.join(fixture.root, "my-package"), root: path.join(fixture.root, "my-package") };
		await writeFile(path.join(fixture.agentDir, "settings.json"), JSON.stringify({ packages: [pkg.source] }));
		const plan = selectionPlan({ skills: [packageSkill("pkg-skill", pkg)] });
		const discovery: DiscoveryContext = {
			skills: [packageSkill("pkg-skill", pkg), packageSkill("other-pkg-skill", pkg)],
			packages: [pkg],
		};

		const result = await generateRuntimeDir(plan, { agentDir: fixture.agentDir, discovery });
		const settings = await generatedSettings(result.runtimeDir);

		expect(settings.packages).toEqual([
			{ source: pkg.source, skills: ["skills/pkg-skill/SKILL.md"], extensions: [] },
		]);
		// Package skills must not also appear as top-level additive paths.
		expect(settings.skills ?? []).toEqual([]);
	});

	it("classifies extension entries under a package root into that package's allowlist", async () => {
		const pkg = { source: "npm:pi-tools", root: path.join(fixture.agentDir, "npm", "node_modules", "pi-tools") };
		await writeFile(path.join(fixture.agentDir, "settings.json"), JSON.stringify({ packages: ["npm:pi-tools"] }));
		const plan = selectionPlan({
			extensions: [{ id: "pkg-ext", entry: path.join(pkg.root, "extensions", "pkg-ext.ts") }],
		});

		const result = await generateRuntimeDir(plan, { agentDir: fixture.agentDir, discovery: { skills: [], packages: [pkg] } });
		const settings = await generatedSettings(result.runtimeDir);

		expect(settings.packages).toEqual([
			{ source: "npm:pi-tools", skills: [], extensions: ["extensions/pkg-ext.ts"] },
		]);
		expect(settings.extensions ?? []).toEqual([]);
	});

	it("keys a package's skill allowlist by the user's exact settings source string", async () => {
		// Pi's discovery tags package skills with the source string as written in
		// settings; the generated allowlist must key off that exact string.
		const pkg = { source: path.join(fixture.root, "obj-package"), root: path.join(fixture.root, "obj-package") };
		await writeFile(
			path.join(fixture.agentDir, "settings.json"),
			JSON.stringify({ packages: [{ source: pkg.source, prompts: ["keep-*"] }] }),
		);
		const plan = selectionPlan({ skills: [packageSkill("obj-skill", pkg)] });
		const discovery: DiscoveryContext = { skills: [packageSkill("obj-skill", pkg)], packages: [pkg] };

		const result = await generateRuntimeDir(plan, { agentDir: fixture.agentDir, discovery });
		const settings = await generatedSettings(result.runtimeDir);

		expect(settings.packages).toEqual([
			{ source: pkg.source, prompts: ["keep-*"], skills: ["skills/obj-skill/SKILL.md"], extensions: [] },
		]);
	});

	it("preserves unmanaged package keys and user settings keys", async () => {
		const pkg = { source: "npm:pi-tools", root: path.join(fixture.agentDir, "npm", "node_modules", "pi-tools") };
		await writeFile(
			path.join(fixture.agentDir, "settings.json"),
			JSON.stringify({
				theme: "dark",
				packages: [{ source: "npm:pi-tools", prompts: ["review-*"], autoload: false }],
			}),
		);

		const result = await generateRuntimeDir(selectionPlan({}), { agentDir: fixture.agentDir, discovery: { skills: [], packages: [pkg] } });
		const settings = await generatedSettings(result.runtimeDir);

		expect(settings.theme).toBe("dark");
		expect(settings.packages).toEqual([
			{ source: "npm:pi-tools", autoload: false, prompts: ["review-*"], skills: [], extensions: [] },
		]);
	});

	it("sets defaultProjectTrust to never for non-default profiles", async () => {
		const result = await generateRuntimeDir(selectionPlan({}), { agentDir: fixture.agentDir, discovery: { skills: [], packages: [] } });

		expect((await generatedSettings(result.runtimeDir)).defaultProjectTrust).toBe("never");
	});

	it("re-includes the real agent dir's unmanaged resource dirs (prompts, themes)", async () => {
		await mkdir(path.join(fixture.agentDir, "prompts"), { recursive: true });
		await mkdir(path.join(fixture.agentDir, "themes"), { recursive: true });

		const result = await generateRuntimeDir(selectionPlan({}), { agentDir: fixture.agentDir, discovery: { skills: [], packages: [] } });
		const settings = await generatedSettings(result.runtimeDir);

		expect(settings.prompts).toContain(path.join(fixture.agentDir, "prompts"));
		expect(settings.themes).toContain(path.join(fixture.agentDir, "themes"));
		expect(settings.skills ?? []).toEqual([]);
		expect(settings.extensions ?? []).toEqual([]);
	});

	it("generates default model and tools in settings.json only when declared", async () => {
		const withBoth = await generateRuntimeDir(
			selectionPlan({ tools: ["read", "grep"], model: { provider: "openai", id: "gpt-5.4", thinkingLevel: "high" } }),
			{ agentDir: fixture.agentDir, discovery: { skills: [], packages: [] } },
		);
		const settings = JSON.parse(await readFile(path.join(withBoth.runtimeDir, "settings.json"), "utf8"));
		expect(settings.defaultTools).toEqual(["read", "grep"]);
		expect(settings.defaultProvider).toBe("openai");
		expect(settings.defaultModel).toBe("gpt-5.4");
		expect(settings.defaultThinkingLevel).toBe("high");

		const bare = await generateRuntimeDir(selectionPlan({}), {
			agentDir: fixture.agentDir,
			discovery: { skills: [], packages: [] },
		});
		const bareSettings = JSON.parse(await readFile(path.join(bare.runtimeDir, "settings.json"), "utf8"));
		expect(bareSettings.defaultTools).toBeUndefined();
		expect(bareSettings.defaultProvider).toBeUndefined();
		expect(bareSettings.defaultModel).toBeUndefined();
		expect(bareSettings.defaultThinkingLevel).toBeUndefined();
	});

	it("writes the launch plan file for the in-pi extension (profile, instructions)", async () => {
		const result = await generateRuntimeDir(selectionPlan({ instructions: "Be picky." }), {
			agentDir: fixture.agentDir,
			discovery: { skills: [], packages: [] },
		});

		const plan = JSON.parse(await readFile(path.join(result.runtimeDir, "pi-profile.json"), "utf8"));
		expect(plan.profile).toBe("review");
		expect(plan.instructions).toBe("Be picky.");
	});

	it("filters the MCP servers into an instance mcp.json when mcps is declared", async () => {
		await writeFile(path.join(fixture.agentDir, "mcp.json"), JSON.stringify({ mcpServers: { github: {}, missing: {} } }));

		const result = await generateRuntimeDir(selectionPlan({ mcps: ["github"] }), {
			agentDir: fixture.agentDir,
			discovery: { skills: [], packages: [] },
		});

		const plan = JSON.parse(await readFile(path.join(result.runtimeDir, "pi-profile.json"), "utf8"));
		expect(plan.mcps).toEqual(["github"]);
		
		const mcpInstance = JSON.parse(await readFile(path.join(result.runtimeDir, "mcp.json"), "utf8"));
		expect(mcpInstance.mcpServers).toEqual({ github: {} });
	});

	it("symlinks the real mcp.json when no mcp allowlist is declared", async () => {
		await writeFile(path.join(fixture.agentDir, "mcp.json"), JSON.stringify({ mcpServers: { github: {} } }));

		const result = await generateRuntimeDir(selectionPlan({ mcps: undefined }), {
			agentDir: fixture.agentDir,
			discovery: { skills: [], packages: [] },
		});

		expect(await realpath(path.join(result.runtimeDir, "mcp.json"))).toBe(
			await realpath(path.join(fixture.agentDir, "mcp.json")),
		);
	});

	it("symlinks auth state but never trust.json for named profiles", async () => {
		await writeFile(path.join(fixture.agentDir, "auth.json"), "{}");
		await writeFile(path.join(fixture.agentDir, "trust.json"), "{}");

		const result = await generateRuntimeDir(selectionPlan({}), { agentDir: fixture.agentDir, discovery: { skills: [], packages: [] } });

		expect(await realpath(path.join(result.runtimeDir, "auth.json"))).toBe(await realpath(path.join(fixture.agentDir, "auth.json")));
		// A stored trust decision would beat defaultProjectTrust: "never" inside
		// Pi and re-enable project auto-discovery — so it must not be linked.
		expect(existsSync(path.join(result.runtimeDir, "trust.json"))).toBe(false);
	});
});

describe("generateRuntimeDir (trusted project merge)", () => {
	const projectSettingsPath = () => path.join(fixture.cwd, ".pi", "settings.json");

	function projectSkill(name: string): SkillEntry {
		return {
			name,
			filePath: path.join(fixture.cwd, ".pi", "skills", name, "SKILL.md"),
			source: "auto",
			scope: "project",
			origin: "top-level",
		};
	}

	it("merges trusted project settings into the base, project wins, nested objects merge", async () => {
		await writeFile(
			path.join(fixture.agentDir, "settings.json"),
			JSON.stringify({ theme: "dark", retry: { enabled: true, maxRetries: 3 }, globalOnly: 1 }),
		);
		await writeFile(
			projectSettingsPath(),
			JSON.stringify({ theme: "light", retry: { maxRetries: 1 }, projectOnly: true }),
		);

		const projectSettings = JSON.parse(await readFile(projectSettingsPath(), "utf8"));
		const result = await generateRuntimeDir(selectionPlan({}), {
			agentDir: fixture.agentDir,
			discovery: { skills: [], packages: [] },
			projectSettings,
		});
		const settings = await generatedSettings(result.runtimeDir);

		expect(settings.theme).toBe("light");
		expect(settings.retry).toEqual({ enabled: true, maxRetries: 1 });
		expect(settings.globalOnly).toBe(1);
		expect(settings.projectOnly).toBe(true);
	});

	it("project resource arrays in project settings never leak into generated settings", async () => {
		await writeFile(projectSettingsPath(), JSON.stringify({ skills: ["/evil/skills"], extensions: ["/evil/ext.ts"] }));
		const projectSettings = JSON.parse(await readFile(projectSettingsPath(), "utf8"));

		const result = await generateRuntimeDir(selectionPlan({}), {
			agentDir: fixture.agentDir,
			discovery: { skills: [], packages: [] },
			projectSettings,
		});
		const settings = await generatedSettings(result.runtimeDir);

		expect(settings.skills).toEqual([]);
		expect(settings.extensions).toEqual([]);
		expect(settings.defaultProjectTrust).toBe("never");
	});

	it("strips the project packages key so project packages never install into the global npm root", async () => {
		await writeFile(projectSettingsPath(), JSON.stringify({ packages: ["npm:evil-package"], theme: "light" }));
		const projectSettings = JSON.parse(await readFile(projectSettingsPath(), "utf8"));

		const result = await generateRuntimeDir(selectionPlan({}), {
			agentDir: fixture.agentDir,
			discovery: { skills: [], packages: [] },
			projectSettings,
		});
		const settings = await generatedSettings(result.runtimeDir);

		expect(settings.packages).toBeUndefined();
		expect(settings.theme).toBe("light");
	});

	it("additively includes selected project-scope skills, ordered before user-scope ones", async () => {
		// Reference order is user-first on purpose: the generator must still
		// emit project paths first so Pi's first-wins collision rule keeps
		// project priority.
		const plan = selectionPlan({ skills: [agentDirSkill("alpha-skill"), projectSkill("proj-skill")] });
		const discovery: DiscoveryContext = {
			skills: [agentDirSkill("alpha-skill"), projectSkill("proj-skill")],
			packages: [],
		};

		const result = await generateRuntimeDir(plan, { agentDir: fixture.agentDir, discovery });
		const settings = await generatedSettings(result.runtimeDir);

		expect(settings.skills).toEqual([
			path.join(fixture.cwd, ".pi", "skills", "proj-skill", "SKILL.md"),
			path.join(fixture.agentDir, "skills", "alpha-skill", "SKILL.md"),
		]);
	});

	it("ignores project settings for the default profile (Pi reads them natively)", async () => {
		const result = await generateRuntimeDir(defaultPlan(), {
			agentDir: fixture.agentDir,
			projectSettings: { theme: "light" },
		});
		const settings = await generatedSettings(result.runtimeDir);

		expect(settings.theme).toBeUndefined();
	});
});

describe("generateRuntimeDir (default profile, unchanged)", () => {
	it("does not set defaultProjectTrust and generates no flags for default", async () => {
		const result = await generateRuntimeDir(defaultPlan(), { agentDir: fixture.agentDir });
		const settings = await generatedSettings(result.runtimeDir);

		expect(settings.defaultProjectTrust).toBeUndefined();
		expect(result.flags).toEqual([]);
	});
});

describe("writeRuntimeFiles (in-session switch rewrite)", () => {
	it("rewrites settings and the launch plan inside an existing runtime dir", async () => {
		const first = await generateRuntimeDir(selectionPlan({}), {
			agentDir: fixture.agentDir,
			discovery: { skills: [], packages: [] },
		});
		await addGlobalSkill(fixture, "alpha-skill");
		const next = selectionPlan({
			profile: "impl",
			skills: [agentDirSkill("alpha-skill")],
			toolReferences: ["read", "mcp__*"],
		});
		(next as ActivationPlan).tools = ["read"];

		await writeRuntimeFiles(first.runtimeDir, next, {
			agentDir: fixture.agentDir,
			discovery: { skills: [agentDirSkill("alpha-skill")], packages: [] },
			planExtras: { switchedFrom: "review", persistSelection: true },
		});

		const settings = await generatedSettings(first.runtimeDir);
		expect(settings.skills).toEqual([path.join(fixture.agentDir, "skills", "alpha-skill", "SKILL.md")]);
		const plan = JSON.parse(await readFile(path.join(first.runtimeDir, "pi-profile.json"), "utf8"));
		expect(plan.profile).toBe("impl");
		expect(plan.agentDir).toBe(fixture.agentDir);
		expect(plan.toolReferences).toEqual(["read", "mcp__*"]);
		expect(plan.switchedFrom).toBe("review");
		expect(plan.persistSelection).toBe(true);
	});

	it("removes the trust.json link when switching from default to a named profile", async () => {
		await writeFile(path.join(fixture.agentDir, "trust.json"), "{}");
		const first = await generateRuntimeDir(defaultPlan(), { agentDir: fixture.agentDir });
		expect(existsSync(path.join(first.runtimeDir, "trust.json"))).toBe(true);

		await writeRuntimeFiles(first.runtimeDir, selectionPlan({}), {
			agentDir: fixture.agentDir,
			discovery: { skills: [], packages: [] },
		});

		expect(existsSync(path.join(first.runtimeDir, "trust.json"))).toBe(false);
	});

	it("restores the trust.json link when switching back to default", async () => {
		await writeFile(path.join(fixture.agentDir, "trust.json"), "{}");
		const first = await generateRuntimeDir(selectionPlan({}), {
			agentDir: fixture.agentDir,
			discovery: { skills: [], packages: [] },
		});
		expect(existsSync(path.join(first.runtimeDir, "trust.json"))).toBe(false);

		await writeRuntimeFiles(first.runtimeDir, defaultPlan(), { agentDir: fixture.agentDir });

		expect(await realpath(path.join(first.runtimeDir, "trust.json"))).toBe(
			await realpath(path.join(fixture.agentDir, "trust.json")),
		);
	});
});
