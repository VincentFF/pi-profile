import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	discoverExtensions,
	discoverImplicitExtensions,
	packageNameFromSource,
	type ImplicitExtensionDiscovery,
} from "../src/extension-discovery.ts";
import { createPiFixture, type PiFixture } from "./helpers/pi-fixture.ts";

let fixture: PiFixture;

beforeEach(async () => {
	fixture = await createPiFixture();
});

afterEach(async () => {
	await rm(fixture.root, { recursive: true, force: true });
});

/** Creates a fake installed package under the fixture's npm root. */
async function addPackage(
	name: string,
	options: { extensions?: string[]; manifestName?: string },
): Promise<{ source: string; root: string }> {
	const root = path.join(fixture.agentDir, "npm", "node_modules", ...name.split("/"));
	await mkdir(root, { recursive: true });
	const manifest: Record<string, unknown> = {};
	if (options.manifestName !== undefined) manifest.name = options.manifestName;
	else manifest.name = name;
	if (options.extensions !== undefined) {
		manifest.pi = { extensions: options.extensions };
		for (const rel of options.extensions) {
			const file = path.join(root, rel);
			await mkdir(path.dirname(file), { recursive: true });
			await writeFile(file, "export default function () {}\n");
		}
	}
	await writeFile(path.join(root, "package.json"), JSON.stringify(manifest));
	return { source: `npm:${name}`, root };
}

async function addLoose(dir: string, name: string): Promise<string> {
	await mkdir(dir, { recursive: true });
	const file = path.join(dir, name);
	await writeFile(file, "export default function () {}\n");
	return file;
}

const EMPTY: ImplicitExtensionDiscovery = { packages: [], local: [], warnings: [] };

describe("packageNameFromSource", () => {
	it("strips prefixes and version specs", () => {
		expect(packageNameFromSource("npm:pi-mcp-adapter")).toBe("pi-mcp-adapter");
		expect(packageNameFromSource("npm:@janvitos/pi-plan-build")).toBe("@janvitos/pi-plan-build");
		expect(packageNameFromSource("npm:@scope/pkg@1.2.3")).toBe("@scope/pkg");
		expect(packageNameFromSource("npm:pkg@^2.0.0")).toBe("pkg");
		expect(packageNameFromSource("git:https://example.com/x.git")).toBe("https://example.com/x.git");
	});
});

describe("discoverImplicitExtensions", () => {
	it("discovers a package's declared pi.extensions entries", async () => {
		const pkg = await addPackage("pi-mcp-adapter", { extensions: ["./index.ts"] });

		const result = await discoverImplicitExtensions({ agentDir: fixture.agentDir, packages: [pkg] });

		expect(result.warnings).toEqual([]);
		expect(result.packages).toEqual([
			{
				name: "pi-mcp-adapter",
				source: "npm:pi-mcp-adapter",
				root: pkg.root,
				entries: [path.join(pkg.root, "index.ts")],
			},
		]);
	});

	it("lists every entry of a multi-entry package", async () => {
		const pkg = await addPackage("pi-multi", { extensions: ["./index.ts", "./panel.ts"] });

		const result = await discoverImplicitExtensions({ agentDir: fixture.agentDir, packages: [pkg] });

		expect(result.packages[0]?.entries).toHaveLength(2);
	});

	it("skips skills-only packages and packages without readable manifests", async () => {
		const skillsOnly = await addPackage("pi-skills", {});
		const notInstalled = { source: "npm:ghost", root: path.join(fixture.agentDir, "npm", "node_modules", "ghost") };

		const result = await discoverImplicitExtensions({
			agentDir: fixture.agentDir,
			packages: [skillsOnly, notInstalled, { source: "npm:unresolved", root: undefined }],
		});

		expect(result.packages).toEqual([]);
	});

	it("skips declared entries missing on disk", async () => {
		const pkg = await addPackage("pi-partial", { extensions: ["./index.ts"] });
		await rm(path.join(pkg.root, "index.ts"));

		const result = await discoverImplicitExtensions({ agentDir: fixture.agentDir, packages: [pkg] });

		expect(result.packages).toEqual([]);
	});

	it("falls back to the source-derived name when the manifest has none", async () => {
		const root = path.join(fixture.agentDir, "npm", "node_modules", "pi-noname");
		await mkdir(root, { recursive: true });
		await writeFile(path.join(root, "index.ts"), "export default function () {}\n");
		await writeFile(path.join(root, "package.json"), JSON.stringify({ pi: { extensions: ["./index.ts"] } }));

		const result = await discoverImplicitExtensions({
			agentDir: fixture.agentDir,
			packages: [{ source: "npm:pi-noname", root }],
		});

		expect(result.packages[0]?.name).toBe("pi-noname");
	});

	it("discovers loose files by filename stem, .ts preferred over a .js sibling", async () => {
		const dir = path.join(fixture.agentDir, "extensions");
		const tsFile = await addLoose(dir, "conventions.ts");
		await addLoose(dir, "conventions.js");
		const other = await addLoose(dir, "review-guard.js");

		const result = await discoverImplicitExtensions({ agentDir: fixture.agentDir, packages: [] });

		expect(result.local).toEqual([
			{ id: "conventions", entry: tsFile },
			{ id: "review-guard", entry: other },
		]);
		expect(result.warnings.some((warning) => warning.includes("conventions"))).toBe(true);
	});

	it("project loose files override same-stem global ones for trusted projects", async () => {
		await addLoose(path.join(fixture.agentDir, "extensions"), "shared.ts");
		const projectFile = await addLoose(path.join(fixture.cwd, ".pi", "extensions"), "shared.ts");

		const result = await discoverImplicitExtensions({
			agentDir: fixture.agentDir,
			packages: [],
			projectDir: fixture.cwd,
		});

		expect(result.local).toEqual([{ id: "shared", entry: projectFile }]);
	});

	it("never scans the project dir when it is not passed (untrusted)", async () => {
		await addLoose(path.join(fixture.cwd, ".pi", "extensions"), "secret.ts");

		const result = await discoverImplicitExtensions({ agentDir: fixture.agentDir, packages: [] });

		expect(result.local).toEqual([]);
	});

	it("an empty discovery result is a valid input", () => {
		expect(EMPTY.packages).toEqual([]);
	});
});

describe("DiscoveredExtensions (pure discovery & selection)", () => {
	it("selects extensions by package name, alias, and loose file stem", async () => {
		const pkg = await addPackage("pi-mcp-adapter", { extensions: ["./index.ts"] });
		const loose = await addLoose(path.join(fixture.agentDir, "extensions"), "conventions.ts");

		const extensions = await discoverExtensions({
			agentDir: fixture.agentDir,
			packages: [pkg],
		});

		const selection = await extensions.select(["pi-mcp-adapter", "conventions"]);
		expect(selection.unmatched).toEqual([]);
		expect(selection.entries.map((e) => e.id).sort()).toEqual(["conventions", "pi-mcp-adapter"]);

		// Also selectable by source alias
		const aliasSelection = await extensions.select(["npm:pi-mcp-adapter"]);
		expect(aliasSelection.entries.map((e) => e.id)).toEqual(["pi-mcp-adapter"]);
	});

	it("selects multi-entry packages as a whole and by individual entry", async () => {
		const pkg = await addPackage("multi-ext", { extensions: ["./a.ts", "./b.ts"] });
		const extensions = await discoverExtensions({ agentDir: fixture.agentDir, packages: [pkg] });

		const all = await extensions.select(["multi-ext"]);
		expect(all.entries.map((e) => e.id).sort()).toEqual(["multi-ext:a.ts", "multi-ext:b.ts"]);

		const single = await extensions.select(["multi-ext:a.ts"]);
		expect(single.entries.map((e) => e.id)).toEqual(["multi-ext:a.ts"]);
	});

	it("expands glob patterns and records unmatched globs", async () => {
		const pkg = await addPackage("pi-mcp-adapter", { extensions: ["./index.ts"] });
		await addLoose(path.join(fixture.agentDir, "extensions"), "pi-guard.ts");
		await addLoose(path.join(fixture.agentDir, "extensions"), "other.ts");

		const extensions = await discoverExtensions({ agentDir: fixture.agentDir, packages: [pkg] });

		const selection = await extensions.select(["pi-*", "nonexistent-*"]);
		expect(selection.entries.map((e) => e.id).sort()).toEqual(["pi-guard", "pi-mcp-adapter"]);
		expect(selection.unmatched).toEqual(["nonexistent-*"]);
	});

	it("resolves absolute and home-relative paths directly, rejecting relative paths", async () => {
		const absFile = await addLoose(path.join(fixture.root, "external"), "custom.ts");
		const extensions = await discoverExtensions({ agentDir: fixture.agentDir, packages: [] });

		const selection = await extensions.select([absFile]);
		expect(selection.entries).toEqual([{ id: absFile, entry: absFile, origin: "path" }]);

		await expect(extensions.select(["./relative/path.ts"])).rejects.toThrow(/relative path/);
		await expect(extensions.select(["/nonexistent/ext.ts"])).rejects.toThrow(/extension path not found/);
	});

	it("fails on unknown literal with candidates and did-you-mean, never mentioning resources.json", async () => {
		await addPackage("pi-mcp-adapter", { extensions: ["./index.ts"] });
		const extensions = await discoverExtensions({ agentDir: fixture.agentDir, packages: [] });

		try {
			await extensions.select(["pi-mcp-adaptr"]);
			expect.unreachable("should have thrown");
		} catch (err) {
			const msg = (err as Error).message;
			expect(msg).toContain("unknown extension");
			expect(msg).not.toContain("resources.json");
		}
	});

	it("resolves local file over package name collision, keeping package selectable by source", async () => {
		const pkg = await addPackage("my-tool", { extensions: ["./index.ts"] });
		const localFile = await addLoose(path.join(fixture.agentDir, "extensions"), "my-tool.ts");

		const extensions = await discoverExtensions({ agentDir: fixture.agentDir, packages: [pkg] });
		expect(extensions.warnings().some((w) => w.includes("my-tool"))).toBe(true);

		const localSelection = await extensions.select(["my-tool"]);
		expect(localSelection.entries).toEqual([{ id: "my-tool", entry: localFile, origin: "local" }]);

		const pkgSelection = await extensions.select(["npm:my-tool"]);
		expect(pkgSelection.entries[0]?.entry).toContain("node_modules");
	});
});
