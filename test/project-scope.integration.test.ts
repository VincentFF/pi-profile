import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { addGlobalSkill, createPiFixture, type PiFixture } from "./helpers/pi-fixture.ts";
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

async function writeGlobalCatalog(profiles: Record<string, unknown>): Promise<void> {
	await writeFile(path.join(fixture.agentDir, "profiles.json"), JSON.stringify({ schemaVersion: 1, profiles }));
}

async function writeProjectCatalog(profiles: Record<string, unknown>): Promise<void> {
	await writeFile(path.join(fixture.cwd, ".pi", "profiles.json"), JSON.stringify({ schemaVersion: 1, profiles }));
}

async function addProjectSkill(name: string): Promise<void> {
	const dir = path.join(fixture.cwd, ".pi", "skills", name);
	await mkdir(dir, { recursive: true });
	await writeFile(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: project skill ${name}\n---\n`);
}

/** A project extension that would auto-load under native trust; the marker
 *  file proves whether its code executed. */
async function addProjectExtension(name: string): Promise<string> {
	const dir = path.join(fixture.cwd, ".pi", "extensions");
	await mkdir(dir, { recursive: true });
	const file = path.join(dir, `${name}.ts`);
	await writeFile(
		file,
		[
			`import { writeFileSync } from "node:fs";`,
			`writeFileSync(${JSON.stringify(path.join(fixture.root, `EXECUTED-${name}`))}, "ran");`,
			`import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";`,
			`export default function (pi: ExtensionAPI) {`,
			`\tpi.registerCommand("${name}", { description: "${name}", handler: async () => {} });`,
			`}`,
			"",
		].join("\n"),
	);
	return file;
}

async function trustProject(): Promise<void> {
	await writeFile(path.join(fixture.agentDir, "trust.json"), JSON.stringify({ [fixture.cwd]: true }));
}

function runLauncher(args: string[]): Promise<{ code: number; stderr: string }> {
	return new Promise((resolve) => {
		const child = execFile(
			"node",
			[BIN, ...args],
			{ cwd: fixture.cwd, env: launcherEnv() },
			(error, _stdout, stderr) => resolve({ code: (error as { code?: number })?.code ?? 0, stderr }),
		);
		child.stdin?.end();
	});
}

describe("launcher integration: project scope and trust", () => {
	it(
		"an untrusted project's catalog, skills, and extensions never enter the runtime",
		{ timeout: 45_000 },
		async () => {
			await addProjectSkill("proj-skill");
			await addProjectExtension("proj-ext");
			await writeProjectCatalog({ impl: { skills: ["proj-skill"] } });
			await addGlobalSkill(fixture, "alpha-skill");
			await writeGlobalCatalog({ review: { skills: ["alpha-skill"] } });

			// The project profile is invisible when untrusted.
			const failure = await runLauncher(["impl", "--", "--mode", "rpc"]);
			expect(failure.code).toBe(2);
			expect(failure.stderr).toContain("unknown profile: impl");

			// A global profile exposes only global resources; the untrusted
			// project's auto-discoverable extension code never runs.
			const rpc = new RpcDriver("node", [BIN, "review", "--", "--mode", "rpc"], {
				cwd: fixture.cwd,
				env: launcherEnv(),
			});
			try {
				const names = (await rpc.commandNames()).map((command) => command.name);
				expect(names).toContain("skill:alpha-skill");
				expect(names).not.toContain("skill:proj-skill");
				expect(names).not.toContain("proj-ext");
			} finally {
				await rpc.close();
			}
			const { existsSync } = await import("node:fs");
			expect(existsSync(path.join(fixture.root, "EXECUTED-proj-ext"))).toBe(false);
		},
	);

	it(
		"a trusted project gets its selected resources included and its settings merged",
		{ timeout: 45_000 },
		async () => {
			await addProjectSkill("proj-skill");
			await addProjectSkill("proj-unselected");
			const entry = await addProjectExtension("proj-ext");
			await writeProjectCatalog({ impl: { skills: ["proj-skill"], extensions: ["proj-ext"] } });
			await writeFile(
				path.join(fixture.cwd, ".pi", "resources.json"),
				JSON.stringify({ schemaVersion: 1, resources: { "proj-ext": { kind: "extension", entry } } }),
			);
			await writeFile(
				path.join(fixture.cwd, ".pi", "settings.json"),
				JSON.stringify({ projectManagedKey: "from-project" }),
			);
			await trustProject();

			const rpc = new RpcDriver("node", [BIN, "impl", "--", "--mode", "rpc"], {
				cwd: fixture.cwd,
				env: launcherEnv(),
			});
			try {
				const names = (await rpc.commandNames()).map((command) => command.name);
				expect(names).toContain("skill:proj-skill");
				expect(names).not.toContain("skill:proj-unselected");
				expect(names).toContain("proj-ext");
			} finally {
				await rpc.close();
			}

			// The generated settings merged the trusted project's unmanaged keys
			// and still suppress project auto-discovery.
			const runtimeRoot = path.join(fixture.agentDir, "pi-profile", "runtime");
			const launches = await readdir(runtimeRoot);
			const generated = JSON.parse(
				await readFile(path.join(runtimeRoot, launches.sort().at(-1)!, "settings.json"), "utf8"),
			);
			expect(generated.projectManagedKey).toBe("from-project");
			expect(generated.defaultProjectTrust).toBe("never");
		},
	);

	it(
		"--approve is a one-run trust input: project profile resolves, resources stay filtered, nothing is persisted",
		{ timeout: 45_000 },
		async () => {
			await addProjectSkill("proj-skill");
			await addProjectSkill("proj-unselected");
			await writeProjectCatalog({ impl: { skills: ["proj-skill"] } });

			const rpc = new RpcDriver("node", [BIN, "impl", "--", "--mode", "rpc", "--approve"], {
				cwd: fixture.cwd,
				env: launcherEnv(),
			});
			try {
				const names = (await rpc.commandNames()).map((command) => command.name);
				expect(names).toContain("skill:proj-skill");
				// Filtered even though this run is trusted: --approve is the
				// resolver's input, never a Pi-side auto-discovery switch.
				expect(names).not.toContain("skill:proj-unselected");
			} finally {
				await rpc.close();
			}

			// One-run input: no trust.json decision was persisted.
			const { existsSync } = await import("node:fs");
			const trustPath = path.join(fixture.agentDir, "trust.json");
			if (existsSync(trustPath)) {
				expect(JSON.parse(await readFile(trustPath, "utf8"))).not.toHaveProperty(fixture.cwd);
			}
		},
	);

	it(
		"--no-approve distrusts despite a stored trust entry",
		{ timeout: 30_000 },
		async () => {
			await writeProjectCatalog({ impl: { skills: [] } });
			await trustProject();

			const failure = await runLauncher(["impl", "--", "--mode", "rpc", "--no-approve"]);
			expect(failure.code).toBe(2);
			expect(failure.stderr).toContain("unknown profile: impl");
		},
	);

	it(
		"a same-name project profile fully replaces the global one at launch",
		{ timeout: 45_000 },
		async () => {
			await addGlobalSkill(fixture, "global-skill");
			await addProjectSkill("proj-skill");
			await writeGlobalCatalog({ review: { skills: ["global-skill"] } });
			await writeProjectCatalog({ review: { skills: ["proj-skill"] } });
			await trustProject();

			const rpc = new RpcDriver("node", [BIN, "review", "--", "--mode", "rpc"], {
				cwd: fixture.cwd,
				env: launcherEnv(),
			});
			try {
				const names = await rpc.skillCommandNames();
				expect(names).toContain("skill:proj-skill");
				expect(names).not.toContain("skill:global-skill");
			} finally {
				await rpc.close();
			}
		},
	);

	it(
		"restores the project-sourced active profile from the project state file",
		{ timeout: 45_000 },
		async () => {
			await addProjectSkill("proj-skill");
			await writeProjectCatalog({ impl: { skills: ["proj-skill"] } });
			await writeFile(
				path.join(fixture.cwd, ".pi", "pi-profile-state.json"),
				JSON.stringify({ activeProfile: "impl" }),
			);
			await trustProject();

			const rpc = new RpcDriver("node", [BIN, "--", "--mode", "rpc"], { cwd: fixture.cwd, env: launcherEnv() });
			try {
				const names = await rpc.skillCommandNames();
				expect(names).toContain("skill:proj-skill");
			} finally {
				await rpc.close();
			}
		},
	);
});
