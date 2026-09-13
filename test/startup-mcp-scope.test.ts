import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MCP_GENERATED_MARKER, mcpSlotPath, mcpSourcePath } from "../src/mcp-overlay.ts";
import {
	readFlagFromArgv,
	resolveProjectTrustedSync,
	resolveStartupProfileNameSync,
	syncMcpOverlayForSelection,
	syncStartupMcpOverlay,
} from "../src/startup-mcp-scope.ts";
import { createPiFixture, type PiFixture } from "./helpers/pi-fixture.ts";

let fixture: PiFixture;

beforeEach(async () => {
	fixture = await createPiFixture();
});

afterEach(async () => {
	await rm(fixture.root, { recursive: true, force: true });
});

const marker = { [MCP_GENERATED_MARKER]: { generated: true, version: 1 } };

async function writeCatalog(profiles: Record<string, unknown>): Promise<void> {
	await writeFile(path.join(fixture.agentDir, "profiles.json"), JSON.stringify({ schemaVersion: 1, profiles }));
}

async function writeState(activeProfile: string): Promise<void> {
	await writeFile(path.join(fixture.agentDir, "pi-profile-state.json"), JSON.stringify({ activeProfile }));
}

async function writeGlobalMcp(servers: Record<string, unknown>, extra: Record<string, unknown> = {}): Promise<void> {
	await writeFile(path.join(fixture.agentDir, "mcp.json"), JSON.stringify({ mcpServers: servers, ...extra }));
}

async function readJson(filePath: string): Promise<Record<string, unknown>> {
	return JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown>;
}

const readOverlay = () => readJson(mcpSlotPath(fixture.agentDir));
const readSidecar = () => readJson(mcpSourcePath(fixture.agentDir));

const loadPass = (overrides: Record<string, unknown> = {}) => ({
	agentDir: fixture.agentDir,
	cwd: fixture.cwd,
	homeDir: fixture.root,
	projectTrusted: true,
	argv: [] as string[],
	...overrides,
});

describe("readFlagFromArgv", () => {
	it("reads both spellings and lets the last one win", () => {
		expect(readFlagFromArgv(["--profile", "review"], "profile")).toBe("review");
		expect(readFlagFromArgv(["--profile=review"], "profile")).toBe("review");
		expect(readFlagFromArgv(["--profile", "a", "--profile", "b"], "profile")).toBe("b");
	});

	it("returns undefined when the flag is absent or valueless", () => {
		expect(readFlagFromArgv([], "profile")).toBeUndefined();
		expect(readFlagFromArgv(["--profile", "--model", "x"], "profile")).toBeUndefined();
	});
});

describe("resolveStartupProfileNameSync", () => {
	it("prefers the command line, then project state, then global state, then default", async () => {
		await writeCatalog({ review: {}, implement: {} });
		await writeState("review");
		await writeFile(
			path.join(fixture.cwd, ".pi", "pi-profile-state.json"),
			JSON.stringify({ activeProfile: "implement" }),
		);

		const base = { agentDir: fixture.agentDir, cwd: fixture.cwd };
		expect(resolveStartupProfileNameSync({ ...base, projectTrusted: true, argv: ["--profile", "other"] })).toBe("other");
		expect(resolveStartupProfileNameSync({ ...base, projectTrusted: true, argv: [] })).toBe("implement");
		expect(resolveStartupProfileNameSync({ ...base, projectTrusted: false, argv: [] })).toBe("review");
	});

	it("prefers the run's continuation over the flag (a reload keeps the selection)", async () => {
		await writeCatalog({ review: {}, implement: {} });
		await writeState("review");

		expect(
			resolveStartupProfileNameSync({
				agentDir: fixture.agentDir,
				cwd: fixture.cwd,
				projectTrusted: true,
				argv: ["--profile", "review"],
				continuation: "implement",
			}),
		).toBe("implement");
	});

	it("falls back to the built-in default", () => {
		expect(
			resolveStartupProfileNameSync({ agentDir: fixture.agentDir, cwd: fixture.cwd, projectTrusted: true, argv: [] }),
		).toBe("default");
	});
});

describe("resolveProjectTrustedSync", () => {
	it("treats a project without trust-requiring resources as trusted", () => {
		expect(resolveProjectTrustedSync(fixture.agentDir, fixture.cwd)).toBe(true);
	});

	it("honours a stored decision and defaultProjectTrust", async () => {
		await mkdir(path.join(fixture.cwd, ".pi", "skills"), { recursive: true });
		await writeFile(path.join(fixture.agentDir, "trust.json"), JSON.stringify({ [fixture.cwd]: false }));

		expect(resolveProjectTrustedSync(fixture.agentDir, fixture.cwd)).toBe(false);

		await writeFile(path.join(fixture.agentDir, "trust.json"), JSON.stringify({}));
		await writeFile(path.join(fixture.agentDir, "settings.json"), JSON.stringify({ defaultProjectTrust: "always" }));
		expect(resolveProjectTrustedSync(fixture.agentDir, fixture.cwd)).toBe(true);
	});

	it("counts an unresolved interactive prompt as untrusted", async () => {
		await mkdir(path.join(fixture.cwd, ".pi", "skills"), { recursive: true });

		expect(resolveProjectTrustedSync(fixture.agentDir, fixture.cwd)).toBe(false);
	});
});

describe("syncStartupMcpOverlay", () => {
	it("adopts a hand-written Pi-global file into the sidecar and generates the overlay", async () => {
		await writeCatalog({ review: { mcps: ["github"] } });
		await writeGlobalMcp({ github: { url: "https://x" }, linear: { command: "mcp-linear" } }, { settings: { toolPrefix: "server" } });

		const result = syncStartupMcpOverlay(loadPass({ argv: ["--profile", "review"] }));

		expect(result).toMatchObject({ managed: true, changed: true });
		expect(await readSidecar()).toEqual({
			mcpServers: { github: { url: "https://x" }, linear: { command: "mcp-linear" } },
			settings: { toolPrefix: "server" },
		});
		expect(await readOverlay()).toEqual({
			...marker,
			settings: { toolPrefix: "server" },
			mcpServers: { github: { url: "https://x" }, linear: { command: "mcp-linear", disabled: true } },
		});
	});

	it("re-reads the sidecar on the next pass instead of the generated file", async () => {
		await writeCatalog({ review: { mcps: ["github"] } });
		await writeState("review");
		await writeGlobalMcp({ github: {}, linear: {} });
		syncStartupMcpOverlay(loadPass());

		// A second pass with a different profile starts from the sidecar, so the
		// stubs written into the slot never feed back as definitions.
		await writeCatalog({ review: { mcps: ["linear"] } });
		expect(syncStartupMcpOverlay(loadPass()).changed).toBe(true);
		expect(await readOverlay()).toEqual({
			...marker,
			mcpServers: { github: { disabled: true }, linear: {} },
		});
	});

	it("uses the saved selection when no flag is given", async () => {
		await writeCatalog({ review: { mcps: ["github"] } });
		await writeState("review");
		await writeGlobalMcp({ github: {}, linear: {} });

		expect(syncStartupMcpOverlay(loadPass()).changed).toBe(true);
		expect(Object.keys((await readOverlay()).mcpServers as object)).toEqual(["github", "linear"]);
	});

	it("passes the sidecar through when the profile declares no mcp", async () => {
		await writeCatalog({ review: {} });
		await writeState("review");
		await writeGlobalMcp({ github: { url: "https://x" } });

		syncStartupMcpOverlay(loadPass());

		expect(await readOverlay()).toEqual({ ...marker, mcpServers: { github: { url: "https://x" } } });
	});

	it("disables every discovered server for an empty allowlist", async () => {
		await writeCatalog({ review: { mcps: [] } });
		await writeState("review");
		await writeGlobalMcp({ github: {} });
		await mkdir(path.join(fixture.root, ".agents"), { recursive: true });
		await writeFile(path.join(fixture.root, ".agents", "mcp.json"), JSON.stringify({ mcpServers: { linear: {} } }));

		syncStartupMcpOverlay(loadPass());

		expect(await readOverlay()).toEqual({
			...marker,
			mcpServers: { github: { disabled: true }, linear: { disabled: true } },
		});
	});

	it("ignores project files when the project is not trusted", async () => {
		await writeCatalog({ review: { mcps: ["github"] } });
		await writeState("review");
		await writeGlobalMcp({ github: {} });
		await writeFile(path.join(fixture.cwd, ".pi", "mcp.json"), JSON.stringify({ mcpServers: { project: {} } }));

		syncStartupMcpOverlay(loadPass({ projectTrusted: false }));

		expect(await readOverlay()).toEqual({ ...marker, mcpServers: { github: {} } });
	});

	it("filters nothing when the profile cannot be resolved", async () => {
		await writeCatalog({ review: { mcps: [] } });
		await writeState("ghost");
		await writeGlobalMcp({ github: {} });

		const result = syncStartupMcpOverlay(loadPass());

		expect(result.changed).toBe(true);
		expect(await readOverlay()).toEqual({ ...marker, mcpServers: { github: {} } });
	});

	it("never touches a foreign --mcp-config", async () => {
		await writeCatalog({ review: { mcps: [] } });
		await writeState("review");
		await writeGlobalMcp({ github: {} });
		const foreign = path.join(fixture.root, "own.json");

		const result = syncStartupMcpOverlay(loadPass({ overridePath: foreign }));

		expect(result).toMatchObject({ managed: false, changed: false });
		await expect(readFile(foreign, "utf8")).rejects.toThrow();
		// The user's own slot file and the sidecar are left untouched.
		expect(await readFile(mcpSlotPath(fixture.agentDir), "utf8")).toBe(JSON.stringify({ mcpServers: { github: {} } }));
		await expect(readFile(mcpSourcePath(fixture.agentDir), "utf8")).rejects.toThrow();
	});

	it("reports an unreadable slot instead of overwriting it", async () => {
		await writeCatalog({ review: { mcps: [] } });
		await writeState("review");
		await writeFile(path.join(fixture.agentDir, "mcp.json"), "{ not json");

		const result = syncStartupMcpOverlay(loadPass());

		expect(result.error).toMatch(/not valid JSON/);
		expect(result.changed).toBe(false);
		expect(await readFile(path.join(fixture.agentDir, "mcp.json"), "utf8")).toBe("{ not json");
	});

	it("is idempotent: an unchanged selection writes nothing", async () => {
		await writeCatalog({ review: { mcps: ["github"] } });
		await writeState("review");
		await writeGlobalMcp({ github: {}, linear: {} });

		expect(syncStartupMcpOverlay(loadPass()).changed).toBe(true);
		expect(syncStartupMcpOverlay(loadPass()).changed).toBe(false);
	});

	it("reports the failure instead of throwing when the catalog is malformed", async () => {
		await writeFile(path.join(fixture.agentDir, "profiles.json"), "{ not json");
		await writeState("review");

		const result = syncStartupMcpOverlay(loadPass());

		expect(result.error).toBeUndefined(); // an unreadable profile filters nothing
		expect(result.changed).toBe(true);
		expect(await readOverlay()).toEqual({ ...marker, mcpServers: {} });
	});
});

describe("syncMcpOverlayForSelection", () => {
	it("mirrors a resolved allowlist", async () => {
		await writeGlobalMcp({ github: {}, linear: {} });

		const result = syncMcpOverlayForSelection({
			agentDir: fixture.agentDir,
			cwd: fixture.cwd,
			homeDir: fixture.root,
			projectTrusted: true,
			allowed: ["github"],
		});

		expect(result).toMatchObject({ managed: true, changed: true });
		expect(await readOverlay()).toEqual({
			...marker,
			mcpServers: { github: {}, linear: { disabled: true } },
		});
	});

	it("does nothing for 'all' when the overlay is already a passthrough", async () => {
		await writeGlobalMcp({ github: {} });
		const input = {
			agentDir: fixture.agentDir,
			cwd: fixture.cwd,
			homeDir: fixture.root,
			projectTrusted: true,
		};

		expect(syncMcpOverlayForSelection({ ...input, allowed: "all" }).changed).toBe(true);
		expect(syncMcpOverlayForSelection({ ...input, allowed: "all" }).changed).toBe(false);
		expect(syncMcpOverlayForSelection({ ...input, allowed: [] }).changed).toBe(true);
	});
});
