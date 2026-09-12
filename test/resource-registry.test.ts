import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { RegistryError, ResourceRegistry } from "../src/resource-registry.ts";
import { createPiFixture, type PiFixture } from "./helpers/pi-fixture.ts";

let fixture: PiFixture;

beforeEach(async () => {
	fixture = await createPiFixture();
});

afterEach(async () => {
	await rm(fixture.root, { recursive: true, force: true });
});

/** Writes a real extension entry file and returns its absolute path. */
async function entryFile(name: string): Promise<string> {
	const dir = path.join(fixture.agentDir, "extensions");
	await mkdir(dir, { recursive: true });
	const file = path.join(dir, `${name}.ts`);
	await writeFile(file, `export default function () {}\n`);
	return file;
}

async function writeRegistry(content: unknown): Promise<void> {
	await writeFile(
		path.join(fixture.agentDir, "resources.json"),
		typeof content === "string" ? content : JSON.stringify(content),
	);
}

async function extensionResource(name: string, extra?: { dependsOn?: string[]; alwaysOn?: boolean }) {
	return { kind: "extension", entry: await entryFile(name), ...extra };
}

describe("ResourceRegistry (global registry)", () => {
	it("loads entries and resolves them by logical ID", async () => {
		await writeRegistry({
			schemaVersion: 1,
			resources: { "review-guard": await extensionResource("review-guard") },
		});

		const registry = await ResourceRegistry.load(fixture.agentDir);
		const entry = registry.get("review-guard");

		expect(entry?.kind).toBe("extension");
		expect(entry?.entry).toBe(path.join(fixture.agentDir, "extensions", "review-guard.ts"));
		expect(entry?.dependsOn).toEqual([]);
		expect(entry?.alwaysOn).toBe(false);
	});

	it("treats a missing registry file as an empty registry", async () => {
		const registry = await ResourceRegistry.load(fixture.agentDir);

		expect(registry.list()).toEqual([]);
		expect(registry.get("anything")).toBeUndefined();
	});

	it("fails loudly on an unsupported schemaVersion", async () => {
		await writeRegistry({ schemaVersion: 2, resources: {} });

		await expect(ResourceRegistry.load(fixture.agentDir)).rejects.toThrow(/schemaVersion/);
	});

	it("fails loudly on a non-extension kind", async () => {
		await writeRegistry({
			schemaVersion: 1,
			resources: { bad: { kind: "mcp", entry: "/tmp/x.ts" } },
		});

		await expect(ResourceRegistry.load(fixture.agentDir)).rejects.toThrow(/bad/);
	});

	describe("dependency closure", () => {
		it("recursively joins declared dependencies into the closure", async () => {
			await writeRegistry({
				schemaVersion: 1,
				resources: {
					"review-guard": await extensionResource("review-guard", { dependsOn: ["audit-log"] }),
					"audit-log": await extensionResource("audit-log", { dependsOn: ["redaction"] }),
					redaction: await extensionResource("redaction"),
				},
			});

			const registry = await ResourceRegistry.load(fixture.agentDir);
			const closure = await registry.closure(["review-guard"]);

			expect(closure.map((entry) => entry.id).sort()).toEqual(["audit-log", "redaction", "review-guard"]);
		});

		it("dedupes diamonds and repeated selections", async () => {
			await writeRegistry({
				schemaVersion: 1,
				resources: {
					a: await extensionResource("a", { dependsOn: ["shared"] }),
					b: await extensionResource("b", { dependsOn: ["shared"] }),
					shared: await extensionResource("shared"),
				},
			});

			const registry = await ResourceRegistry.load(fixture.agentDir);
			const closure = await registry.closure(["a", "b", "shared"]);

			expect(closure.map((entry) => entry.id).sort()).toEqual(["a", "b", "shared"]);
		});

		it("fails activation on a dependency cycle", async () => {
			await writeRegistry({
				schemaVersion: 1,
				resources: {
					a: await extensionResource("a", { dependsOn: ["b"] }),
					b: await extensionResource("b", { dependsOn: ["a"] }),
				},
			});

			const registry = await ResourceRegistry.load(fixture.agentDir);

			await expect(registry.closure(["a"])).rejects.toThrow(/cycle/i);
		});

		it("fails activation when a dependency is not registered", async () => {
			await writeRegistry({
				schemaVersion: 1,
				resources: { a: await extensionResource("a", { dependsOn: ["ghost"] }) },
			});

			const registry = await ResourceRegistry.load(fixture.agentDir);

			await expect(registry.closure(["a"])).rejects.toThrow(/ghost/);
		});

		it("fails activation when a selected ID is not registered", async () => {
			const registry = await ResourceRegistry.load(fixture.agentDir);

			await expect(registry.closure(["ghost"])).rejects.toThrow(RegistryError);
		});

		it("fails activation when an entry file is missing on disk", async () => {
			await writeRegistry({
				schemaVersion: 1,
				resources: {
					broken: { kind: "extension", entry: path.join(fixture.agentDir, "extensions", "missing.ts") },
				},
			});

			const registry = await ResourceRegistry.load(fixture.agentDir);

			await expect(registry.closure(["broken"])).rejects.toThrow(/missing\.ts/);
		});
	});

	it("reports alwaysOn entries separately from the selection", async () => {
		await writeRegistry({
			schemaVersion: 1,
			resources: {
				"security-gate": await extensionResource("security-gate", { alwaysOn: true }),
				"review-guard": await extensionResource("review-guard"),
			},
		});

		const registry = await ResourceRegistry.load(fixture.agentDir);

		expect(registry.alwaysOn().map((entry) => entry.id)).toEqual(["security-gate"]);
	});

	describe("project registry (trusted projects only)", () => {
		async function writeProjectRegistry(resources: Record<string, unknown>): Promise<void> {
			await writeFile(
				path.join(fixture.cwd, ".pi", "resources.json"),
				JSON.stringify({ schemaVersion: 1, resources }),
			);
		}

		async function projectEntryFile(name: string): Promise<string> {
			const dir = path.join(fixture.cwd, ".pi", "extensions");
			await mkdir(dir, { recursive: true });
			const file = path.join(dir, `${name}.ts`);
			await writeFile(file, "export default function () {}\n");
			return file;
		}

		it("a same-ID project entry overrides the global entry", async () => {
			await writeRegistry({
				schemaVersion: 1,
				resources: { tool: { kind: "extension", entry: await entryFile("global-tool") } },
			});
			const projectEntry = await projectEntryFile("project-tool");
			await writeProjectRegistry({ tool: { kind: "extension", entry: projectEntry } });

			const registry = await ResourceRegistry.load(fixture.agentDir, { projectDir: fixture.cwd });

			expect(registry.get("tool")?.entry).toBe(projectEntry);
		});

		it("project entries add new IDs alongside global ones", async () => {
			await writeRegistry({
				schemaVersion: 1,
				resources: { global: { kind: "extension", entry: await entryFile("global-ext") } },
			});
			await writeProjectRegistry({ local: { kind: "extension", entry: await projectEntryFile("local-ext") } });

			const registry = await ResourceRegistry.load(fixture.agentDir, { projectDir: fixture.cwd });

			expect(registry.list().map((entry) => entry.id).sort()).toEqual(["global", "local"]);
		});

		it("without a project dir, project registries are not read at all", async () => {
			await writeProjectRegistry({ local: { kind: "extension", entry: await projectEntryFile("local-ext") } });

			const registry = await ResourceRegistry.load(fixture.agentDir);

			expect(registry.get("local")).toBeUndefined();
		});

		it("alwaysOn from a project entry loads in every profile too", async () => {
			await writeProjectRegistry({
				gate: { kind: "extension", entry: await projectEntryFile("gate"), alwaysOn: true },
			});

			const registry = await ResourceRegistry.load(fixture.agentDir, { projectDir: fixture.cwd });

			expect(registry.alwaysOn().map((entry) => entry.id)).toEqual(["gate"]);
		});
	});
});
