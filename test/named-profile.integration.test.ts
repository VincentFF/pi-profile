import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { addGlobalSkill, createPiFixture, listFiles, type PiFixture } from "./helpers/pi-fixture.ts";
import { RpcDriver } from "./helpers/rpc-driver.ts";

const BIN = path.resolve("bin/pi-profile.ts");

let fixture: PiFixture;

beforeEach(async () => {
	fixture = await createPiFixture();
});

afterEach(async () => {
	await rm(fixture.root, { recursive: true, force: true });
});

function launcherEnv(): NodeJS.ProcessEnv {
	return {
		...process.env,
		HOME: fixture.root,
		PI_CODING_AGENT_DIR: fixture.agentDir,
		PI_OFFLINE: "1",
	};
}

async function writeCatalog(profiles: Record<string, unknown>): Promise<void> {
	await writeFile(path.join(fixture.agentDir, "profiles.json"), JSON.stringify({ schemaVersion: 1, profiles }));
}

async function writeResources(resources: Record<string, unknown>): Promise<void> {
	await writeFile(path.join(fixture.agentDir, "resources.json"), JSON.stringify({ schemaVersion: 1, resources }));
}

/** An extension entry file that registers a same-named command and leaves a
 *  top-level side-effect marker if its code ever executes. */
async function addExtensionEntry(name: string): Promise<string> {
	const dir = path.join(fixture.root, "ext-entries");
	await mkdir(dir, { recursive: true });
	const file = path.join(dir, `${name}.ts`);
	await writeFile(
		file,
		[
			`import { writeFileSync } from "node:fs";`,
			`writeFileSync(${JSON.stringify(path.join(fixture.root, `EXECUTED-${name}`))}, "ran");`,
			`import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";`,
			`export default function (pi: ExtensionAPI) {`,
			`\tpi.registerCommand("${name}", { description: "${name} command", handler: async () => {} });`,
			`}`,
			"",
		].join("\n"),
	);
	return file;
}

async function addAgentsSkill(name: string): Promise<void> {
	const dir = path.join(fixture.root, ".agents", "skills", name);
	await mkdir(dir, { recursive: true });
	await writeFile(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: agents skill ${name}\n---\n`);
}

describe("launcher integration: named global profiles", () => {
	it(
		"pi-profile <name> exposes only the profile's resolved skills and extensions",
		{ timeout: 45_000 },
		async () => {
			await addGlobalSkill(fixture, "alpha-skill");
			await addGlobalSkill(fixture, "beta-skill");
			await addAgentsSkill("shared-skill");
			await addAgentsSkill("secret-skill");
			const selectedEntry = await addExtensionEntry("selected-ext");
			const unselectedEntry = await addExtensionEntry("unselected-ext");
			const unregisteredEntry = await addExtensionEntry("unregistered-ext");
			await writeCatalog({
				review: { skills: ["alpha-skill", "shared-skill"], extensions: ["review-guard"] },
			});
			await writeResources({
				"review-guard": { kind: "extension", entry: selectedEntry },
				"other-ext": { kind: "extension", entry: unselectedEntry },
			});
			void unregisteredEntry;

			const rpc = new RpcDriver("node", [BIN, "review", "--", "--mode", "rpc"], {
				cwd: fixture.cwd,
				env: launcherEnv(),
			});
			try {
				const commands = await rpc.commandNames();
				const names = commands.map((command) => command.name);
				// Selected skills are visible; unselected ones are not.
				expect(names).toContain("skill:alpha-skill");
				expect(names).toContain("skill:shared-skill");
				expect(names).not.toContain("skill:beta-skill");
				expect(names).not.toContain("skill:secret-skill");
				// Selected extension code runs; unselected/unregistered does not.
				expect(commands.some((command) => command.name === "selected-ext" && command.source === "extension")).toBe(true);
				expect(names).not.toContain("unselected-ext");
				expect(names).not.toContain("unregistered-ext");
			} finally {
				await rpc.close();
			}

			const { existsSync } = await import("node:fs");
			expect(existsSync(path.join(fixture.root, "EXECUTED-unselected-ext"))).toBe(false);
			expect(existsSync(path.join(fixture.root, "EXECUTED-unregistered-ext"))).toBe(false);
		},
	);

	it(
		"restores the saved active profile when no positional name is given",
		{ timeout: 45_000 },
		async () => {
			await addGlobalSkill(fixture, "alpha-skill");
			await addGlobalSkill(fixture, "beta-skill");
			await writeCatalog({ review: { skills: ["alpha-skill"] } });
			await writeFile(
				path.join(fixture.agentDir, "pi-profile-state.json"),
				JSON.stringify({ activeProfile: "review" }),
			);

			const rpc = new RpcDriver("node", [BIN, "--", "--mode", "rpc"], { cwd: fixture.cwd, env: launcherEnv() });
			try {
				const names = await rpc.skillCommandNames();
				expect(names).toContain("skill:alpha-skill");
				expect(names).not.toContain("skill:beta-skill");
			} finally {
				await rpc.close();
			}
		},
	);

	it(
		"re-expands skill globs on every start",
		{ timeout: 60_000 },
		async () => {
			await addGlobalSkill(fixture, "research-web");
			await writeCatalog({ research: { skills: ["research-*"] } });

			const first = new RpcDriver("node", [BIN, "research", "--", "--mode", "rpc"], {
				cwd: fixture.cwd,
				env: launcherEnv(),
			});
			try {
				expect(await first.skillCommandNames()).toEqual(["skill:research-web"]);
			} finally {
				await first.close();
			}

			// A new matching skill appears after the first launch resolved the glob.
			await addGlobalSkill(fixture, "research-docs");
			const second = new RpcDriver("node", [BIN, "research", "--", "--mode", "rpc"], {
				cwd: fixture.cwd,
				env: launcherEnv(),
			});
			try {
				expect(await second.skillCommandNames()).toEqual(["skill:research-docs", "skill:research-web"]);
			} finally {
				await second.close();
			}
		},
	);

	it(
		"applies the declared model and thinking level via generated flags",
		{ timeout: 45_000 },
		async () => {
			await writeFile(
				path.join(fixture.agentDir, "models.json"),
				JSON.stringify({
					providers: {
						testprov: {
							baseUrl: "http://localhost:9/v1",
							api: "openai-completions",
							apiKey: "static-key",
							models: [{ id: "test-model", reasoning: true }],
						},
					},
				}),
			);
			await writeCatalog({ focused: { model: { provider: "testprov", id: "test-model", thinkingLevel: "high" } } });

			const rpc = new RpcDriver("node", [BIN, "focused", "--", "--mode", "rpc"], {
				cwd: fixture.cwd,
				env: launcherEnv(),
			});
			try {
				const state = await rpc.send({ type: "get_state" });
				const model = state.data?.model as { provider: string; id: string } | undefined;
				expect(model?.provider).toBe("testprov");
				expect(model?.id).toBe("test-model");
				expect(state.data?.thinkingLevel).toBe("high");
			} finally {
				await rpc.close();
			}
		},
	);

	it(
		"appends declared instructions to the system prompt before the first agent turn",
		{ timeout: 45_000 },
		async () => {
			await addGlobalSkill(fixture, "alpha-skill");
			await addGlobalSkill(fixture, "beta-skill");
			await writeFile(
				path.join(fixture.agentDir, "models.json"),
				JSON.stringify({
					providers: {
						testprov: {
							baseUrl: "http://localhost:9/v1",
							api: "openai-completions",
							apiKey: "static-key",
							models: [{ id: "test-model" }],
						},
					},
				}),
			);
			await writeFile(path.join(fixture.agentDir, "settings.json"), JSON.stringify({ retry: { enabled: false } }));
			await writeCatalog({
				review: { skills: ["alpha-skill"], instructions: "PROFILE INSTRUCTIONS MARKER" },
			});
			// Probe extension loaded after pi-profile captures the chained system prompt.
			const captureFile = path.join(fixture.root, "captured-prompt.txt");
			const probe = path.join(fixture.root, "probe.ts");
			await writeFile(
				probe,
				[
					`import { writeFileSync } from "node:fs";`,
					`import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";`,
					`export default function (pi: ExtensionAPI) {`,
					`\tpi.on("before_agent_start", (event) => {`,
					`\t\twriteFileSync(${JSON.stringify(captureFile)}, event.systemPrompt);`,
					`\t});`,
					`}`,
					"",
				].join("\n"),
			);

			const rpc = new RpcDriver("node", [BIN, "review", "--", "--mode", "rpc", "-e", probe], {
				cwd: fixture.cwd,
				env: launcherEnv(),
			});
			try {
				// The prompt fails fast (unreachable fixture provider, retries off),
				// but before_agent_start has already fired by then.
				await rpc.send({ type: "prompt", message: "hello" }, 15_000).catch(() => undefined);
				await new Promise((resolve) => setTimeout(resolve, 2_000));
			} finally {
				await rpc.close();
			}

			const prompt = await readFile(captureFile, "utf8");
			expect(prompt).toContain("PROFILE INSTRUCTIONS MARKER");
			// The model only sees the selected skill in the system prompt…
			expect(prompt).toContain("alpha-skill");
			expect(prompt).not.toContain("beta-skill");
		},
	);

	it(
		"fails activation before spawn when the declared model is unauthenticated",
		{ timeout: 30_000 },
		async () => {
			await writeCatalog({ broken: { model: { provider: "anthropic", id: "claude-sonnet-4-5" } } });
			const { execFile } = await import("node:child_process");

			const failure = await new Promise<{ code: number; stderr: string }>((resolve) => {
				execFile("node", [BIN, "broken", "--", "--mode", "rpc"], { cwd: fixture.cwd, env: launcherEnv() }, (error, _stdout, stderr) => {
					resolve({ code: (error as { code?: number })?.code ?? 0, stderr });
				});
			});

			expect(failure.code).toBe(1);
			expect(failure.stderr).toContain("anthropic");
			// No runtime dir was generated: resolution failed before spawn.
			const files = await listFiles(fixture.agentDir);
			expect(files.filter((file) => path.relative(fixture.agentDir, file).startsWith("pi-profile"))).toEqual([]);
		},
	);

	it(
		"fails activation before spawn on a dependency cycle in the registry",
		{ timeout: 30_000 },
		async () => {
			const a = await addExtensionEntry("cycle-a");
			const b = await addExtensionEntry("cycle-b");
			await writeCatalog({ review: { extensions: ["a"] } });
			await writeResources({
				a: { kind: "extension", entry: a, dependsOn: ["b"] },
				b: { kind: "extension", entry: b, dependsOn: ["a"] },
			});
			const { execFile } = await import("node:child_process");

			const failure = await new Promise<{ code: number; stderr: string }>((resolve) => {
				execFile("node", [BIN, "review", "--", "--mode", "rpc"], { cwd: fixture.cwd, env: launcherEnv() }, (error, _stdout, stderr) => {
					resolve({ code: (error as { code?: number })?.code ?? 0, stderr });
				});
			});

			expect(failure.code).toBe(1);
			expect(failure.stderr).toMatch(/cycle/i);
		},
	);

	it(
		"writes no runtime state and leaves user files untouched for positional launches",
		{ timeout: 45_000 },
		async () => {
			await addGlobalSkill(fixture, "alpha-skill");
			await writeCatalog({ review: { skills: ["alpha-skill"] } });
			const userSettings = { customKey: "keep-me" };
			await writeFile(path.join(fixture.agentDir, "settings.json"), JSON.stringify(userSettings));
			const agentDirBefore = await listFiles(fixture.agentDir);

			const rpc = new RpcDriver("node", [BIN, "review", "--", "--mode", "rpc"], {
				cwd: fixture.cwd,
				env: launcherEnv(),
			});
			try {
				await rpc.commandNames();
			} finally {
				await rpc.close();
			}

			expect(JSON.parse(await readFile(path.join(fixture.agentDir, "settings.json"), "utf8"))).toEqual(userSettings);
			const agentDirAfter = await listFiles(fixture.agentDir);
			const created = agentDirAfter.filter((file) => !agentDirBefore.includes(file));
			for (const file of created) {
				const relative = path.relative(fixture.agentDir, file);
				expect(relative.startsWith(path.join("pi-profile", "runtime")) || relative.startsWith("sessions")).toBe(true);
			}
			const files = await listFiles(fixture.root);
			expect(files.filter((file) => file.endsWith("pi-profile-state.json"))).toEqual([]);
		},
	);
});
