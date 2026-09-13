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

describe("implicit discovery merge (ADR-0006)", () => {
	async function packageEntry(name: string, file = "index.ts"): Promise<{ root: string; entry: string }> {
		const root = path.join(fixture.agentDir, "npm", "node_modules", name);
		await mkdir(root, { recursive: true });
		const entry = path.join(root, file);
		await writeFile(entry, "export default function () {}\n");
		return { root, entry };
	}

	it("installed packages are selectable by name with zero registration", async () => {
		const pkg = await packageEntry("pi-mcp-adapter");
		const registry = await ResourceRegistry.load(fixture.agentDir, {
			implicit: {
				packages: [{ name: "pi-mcp-adapter", source: "npm:pi-mcp-adapter", root: pkg.root, entries: [pkg.entry] }],
				local: [],
				warnings: [],
			},
		});

		const selected = await registry.select(["pi-mcp-adapter"]);

		expect(selected.entries.map((entry) => ({ id: entry.id, entry: entry.entry, origin: entry.origin }))).toEqual([
			{ id: "pi-mcp-adapter", entry: pkg.entry, origin: "package" },
		]);
		expect(selected.unmatched).toEqual([]);
	});

	it("the npm: source string is accepted as an alias", async () => {
		const pkg = await packageEntry("pi-mcp-adapter");
		const registry = await ResourceRegistry.load(fixture.agentDir, {
			implicit: {
				packages: [{ name: "pi-mcp-adapter", source: "npm:pi-mcp-adapter", root: pkg.root, entries: [pkg.entry] }],
				local: [],
				warnings: [],
			},
		});

		const selected = await registry.select(["npm:pi-mcp-adapter"]);

		expect(selected.entries.map((entry) => entry.id)).toEqual(["pi-mcp-adapter"]);
	});

	it("a multi-entry package selects all entries by name, single entries by id", async () => {
		const root = path.join(fixture.agentDir, "npm", "node_modules", "pi-multi");
		await mkdir(root, { recursive: true });
		const a = path.join(root, "index.ts");
		const b = path.join(root, "panel.ts");
		await writeFile(a, "export default function () {}\n");
		await writeFile(b, "export default function () {}\n");
		const registry = await ResourceRegistry.load(fixture.agentDir, {
			implicit: { packages: [{ name: "pi-multi", source: "npm:pi-multi", root, entries: [a, b] }], local: [], warnings: [] },
		});

		expect(registry.list().map((entry) => entry.id).sort()).toEqual(["pi-multi:index.ts", "pi-multi:panel.ts"]);
		const byName = await registry.select(["pi-multi"]);
		expect(byName.entries.map((entry) => entry.entry).sort()).toEqual([a, b]);
		const byId = await registry.select(["pi-multi:panel.ts"]);
		expect(byId.entries.map((entry) => entry.entry)).toEqual([b]);
	});

	it("a loose file colliding with a package name wins the ID; the package stays selectable via its source", async () => {
		const pkg = await packageEntry("foo");
		const localEntry = await entryFile("foo");
		const registry = await ResourceRegistry.load(fixture.agentDir, {
			implicit: {
				packages: [{ name: "foo", source: "npm:foo", root: pkg.root, entries: [pkg.entry] }],
				local: [{ id: "foo", entry: localEntry }],
				warnings: [],
			},
		});

		expect(registry.get("foo")?.entry).toBe(localEntry);
		expect(registry.warnings().some((warning) => warning.includes('"foo"'))).toBe(true);
		const viaAlias = await registry.select(["npm:foo"]);
		expect(viaAlias.entries.map((entry) => entry.entry)).toEqual([pkg.entry]);
	});

	it("an explicit override may omit entry and inherit the discovered one", async () => {
		const pkg = await packageEntry("pi-web-access");
		await writeRegistry({
			schemaVersion: 1,
			resources: { "pi-web-access": { kind: "extension", alwaysOn: true } },
		});
		const registry = await ResourceRegistry.load(fixture.agentDir, {
			implicit: {
				packages: [{ name: "pi-web-access", source: "npm:pi-web-access", root: pkg.root, entries: [pkg.entry] }],
				local: [],
				warnings: [],
			},
		});

		const entry = registry.get("pi-web-access");
		expect(entry?.entry).toBe(pkg.entry);
		expect(entry?.alwaysOn).toBe(true);
		expect(entry?.origin).toBe("explicit");
		expect(registry.alwaysOn().map((candidate) => candidate.id)).toEqual(["pi-web-access"]);
	});

	it("an entry-less override with no discovered match dangles: load succeeds, referencing it fails", async () => {
		await writeRegistry({ schemaVersion: 1, resources: { ghost: { kind: "extension" } } });

		const registry = await ResourceRegistry.load(fixture.agentDir);

		expect(registry.get("ghost")).toBeUndefined();
		expect(registry.warnings().some((warning) => warning.includes('"ghost"'))).toBe(true);
		await expect(registry.select(["ghost"])).rejects.toThrow(/has no entry/);
	});

	it("a dangling alwaysOn override joins every closure (fail-closed), then fails loudly", async () => {
		await writeRegistry({ schemaVersion: 1, resources: { gate: { kind: "extension", alwaysOn: true } } });

		const registry = await ResourceRegistry.load(fixture.agentDir);

		expect(registry.alwaysOnIds()).toEqual(["gate"]);
		await expect(registry.closure(registry.alwaysOnIds())).rejects.toThrow(/gate.*has no entry/);
	});

	it("explicit entries still override implicit ones field-by-field", async () => {
		const pkg = await packageEntry("foo");
		const explicitEntry = await entryFile("foo-explicit");
		await writeRegistry({
			schemaVersion: 1,
			resources: { foo: { kind: "extension", entry: explicitEntry } },
		});
		const registry = await ResourceRegistry.load(fixture.agentDir, {
			implicit: {
				packages: [{ name: "foo", source: "npm:foo", root: pkg.root, entries: [pkg.entry] }],
				local: [],
				warnings: [],
			},
		});

		expect(registry.get("foo")?.entry).toBe(explicitEntry);
		expect(registry.get("foo")?.origin).toBe("explicit");
	});

	it("dependsOn may target implicit package IDs", async () => {
		const pkg = await packageEntry("base-ext");
		await writeRegistry({
			schemaVersion: 1,
			resources: { top: { kind: "extension", entry: await entryFile("top"), dependsOn: ["base-ext"] } },
		});
		const registry = await ResourceRegistry.load(fixture.agentDir, {
			implicit: {
				packages: [{ name: "base-ext", source: "npm:base-ext", root: pkg.root, entries: [pkg.entry] }],
				local: [],
				warnings: [],
			},
		});

		const closure = await registry.closure(["top"]);
		expect(closure.map((entry) => entry.id).sort()).toEqual(["base-ext", "top"]);
	});

	describe("select()", () => {
		it("expands globs against IDs and package names", async () => {
			const pkg = await packageEntry("pi-web-access");
			const local = await entryFile("local-gate");
			const registry = await ResourceRegistry.load(fixture.agentDir, {
				implicit: {
					packages: [{ name: "pi-web-access", source: "npm:pi-web-access", root: pkg.root, entries: [pkg.entry] }],
					local: [{ id: "local-gate", entry: local }],
					warnings: [],
				},
			});

			const selected = await registry.select(["pi-*", "local-*"]);

			expect(selected.entries.map((entry) => entry.id).sort()).toEqual(["local-gate", "pi-web-access"]);
		});

		it("collects zero-match globs instead of failing", async () => {
			const registry = await ResourceRegistry.load(fixture.agentDir);

			const selected = await registry.select(["ghost-*"]);

			expect(selected.entries).toEqual([]);
			expect(selected.unmatched).toEqual(["ghost-*"]);
		});

		it("accepts an existing on-disk path as an ad-hoc entry", async () => {
			const file = await entryFile("one-off");
			const registry = await ResourceRegistry.load(fixture.agentDir);

			const selected = await registry.select([file]);

			expect(selected.entries).toEqual([
				{ id: file, kind: "extension", entry: file, dependsOn: [], alwaysOn: false, origin: "path" },
			]);
		});

		it("fails loudly for a missing path and for relative paths", async () => {
			const registry = await ResourceRegistry.load(fixture.agentDir);

			await expect(registry.select([path.join(fixture.agentDir, "extensions", "missing.ts")])).rejects.toThrow(
				/extension path not found/,
			);
			await expect(registry.select(["./local.ts"])).rejects.toThrow(/relative path/);
		});

		it("unknown literals fail with candidates, a did-you-mean, and a registration example", async () => {
			const pkg = await packageEntry("pi-mcp-adapter");
			const registry = await ResourceRegistry.load(fixture.agentDir, {
				implicit: {
					packages: [{ name: "pi-mcp-adapter", source: "npm:pi-mcp-adapter", root: pkg.root, entries: [pkg.entry] }],
					local: [],
					warnings: [],
				},
			});

			const error = await registry.select(["mcp-adapter"]).catch((caught: unknown) => caught);

			expect(error).toBeInstanceOf(RegistryError);
			const message = (error as Error).message;
			expect(message).toContain('unknown extension: "mcp-adapter"');
			expect(message).toContain("pi-mcp-adapter");
			expect(message).toContain('did you mean "pi-mcp-adapter"');
			expect(message).toContain("resources.json");
		});
	});
});
